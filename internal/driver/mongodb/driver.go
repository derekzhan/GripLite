package mongodb

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GripLite/internal/driver"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
)

const connectionModeParam = "_gripliteMongoConnectionMode"
const defaultFindLimit int64 = 1000

func init() {
	driver.Register(driver.DriverMongoDB, func(cfg driver.ConnectionConfig) (driver.DatabaseDriver, error) {
		return New(cfg)
	})
}

type mongoDriver struct {
	cfg           driver.ConnectionConfig
	client        *mongo.Client
	serverVersion string
}

func New(cfg driver.ConnectionConfig) (*mongoDriver, error) {
	if cfg.Host == "" {
		return nil, fmt.Errorf("mongodb: host is required")
	}
	if cfg.Port == 0 {
		cfg.Port = 27017
	}
	return &mongoDriver{cfg: cfg}, nil
}

func (d *mongoDriver) Connect(ctx context.Context) error {
	if d.client != nil {
		return driver.ErrAlreadyConnected
	}
	timeout := d.cfg.ConnectTimeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}

	client, err := mongo.Connect(options.Client().
		ApplyURI(buildURI(d.cfg, mongoConnectionMode(d.cfg))).
		SetConnectTimeout(timeout).
		SetServerSelectionTimeout(timeout))
	if err != nil {
		return fmt.Errorf("mongodb: connect: %w", err)
	}
	if err := client.Ping(ctx, readpref.Primary()); err != nil {
		_ = client.Disconnect(context.Background())
		return fmt.Errorf("mongodb: ping: %w", err)
	}

	var buildInfo bson.M
	if err := client.Database("admin").RunCommand(ctx, bson.D{{Key: "buildInfo", Value: 1}}).Decode(&buildInfo); err == nil {
		if version, ok := buildInfo["version"].(string); ok {
			d.serverVersion = version
		}
	}

	d.client = client
	return nil
}

func (d *mongoDriver) Close(ctx context.Context) error {
	if d.client == nil {
		return nil
	}
	err := d.client.Disconnect(ctx)
	d.client = nil
	return err
}

func (d *mongoDriver) Ping(ctx context.Context) error {
	if d.client == nil {
		return driver.ErrNotConnected
	}
	return d.client.Ping(ctx, readpref.Primary())
}

func (d *mongoDriver) FetchDatabases(ctx context.Context) ([]string, error) {
	if d.client == nil {
		return nil, driver.ErrNotConnected
	}
	return d.client.ListDatabaseNames(ctx, bson.D{})
}

func (d *mongoDriver) FetchTables(ctx context.Context, dbName string) ([]driver.TableInfo, error) {
	if d.client == nil {
		return nil, driver.ErrNotConnected
	}
	names, err := d.client.Database(dbName).ListCollectionNames(ctx, bson.D{})
	if err != nil {
		return nil, fmt.Errorf("mongodb: list collections: %w", err)
	}
	out := make([]driver.TableInfo, 0, len(names))
	for _, name := range names {
		out = append(out, driver.TableInfo{
			Name:      name,
			Schema:    dbName,
			Kind:      driver.ObjectCollection,
			RowCount:  -1,
			SizeBytes: -1,
		})
	}
	return out, nil
}

func (d *mongoDriver) FetchTableDetail(ctx context.Context, dbName, tableName string) (*driver.TableDetail, error) {
	if d.client == nil {
		return nil, driver.ErrNotConnected
	}
	coll := d.client.Database(dbName).Collection(tableName)
	detail := &driver.TableDetail{
		TableInfo: driver.TableInfo{
			Name:      tableName,
			Schema:    dbName,
			Kind:      driver.ObjectCollection,
			RowCount:  -1,
			SizeBytes: -1,
		},
		Columns: []driver.ColumnInfo{{
			Name:         "_id",
			DatabaseType: "ObjectId",
			Nullable:     false,
			PrimaryKey:   true,
			Ordinal:      0,
		}},
	}

	var sample bson.M
	err := coll.FindOne(ctx, bson.D{}).Decode(&sample)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fmt.Errorf("mongodb: sample collection: %w", err)
	}
	if err == nil {
		detail.Columns = inferColumns([]bson.M{sample})
		for i := range detail.Columns {
			detail.Columns[i].DatabaseType = mongoTypeName(sample[detail.Columns[i].Name])
			detail.Columns[i].PrimaryKey = detail.Columns[i].Name == "_id"
		}
	}

	indexCursor, err := coll.Indexes().List(ctx)
	if err != nil {
		return detail, nil
	}
	defer indexCursor.Close(ctx)
	for indexCursor.Next(ctx) {
		var idx bson.M
		if err := indexCursor.Decode(&idx); err != nil {
			continue
		}
		info := driver.IndexInfo{
			Name:    fmt.Sprint(idx["name"]),
			Unique:  idx["unique"] == true,
			Primary: idx["name"] == "_id_",
		}
		if keyDoc, ok := idx["key"].(bson.M); ok {
			for key := range keyDoc {
				info.Columns = append(info.Columns, key)
			}
			sort.Strings(info.Columns)
		}
		detail.Indexes = append(detail.Indexes, info)
	}
	return detail, nil
}

func (d *mongoDriver) ExecuteQuery(ctx context.Context, query string) (*driver.ResultSet, error) {
	return d.ExecuteQueryOnDB(ctx, d.cfg.Database, query)
}

func (d *mongoDriver) ExecuteQueryOnDB(ctx context.Context, dbName, query string) (*driver.ResultSet, error) {
	if d.client == nil {
		return nil, driver.ErrNotConnected
	}
	if dbName == "" {
		dbName = d.cfg.Database
	}
	if dbName == "" {
		dbName = "admin"
	}
	op, err := ParseMongoOperation(dbName, query)
	if err != nil {
		return nil, err
	}
	if err := validateOperationAllowed(*op, d.cfg.ReadOnly); err != nil {
		return nil, err
	}
	start := time.Now()
	rs, err := d.executeOperation(ctx, *op)
	if err != nil {
		return nil, err
	}
	rs.ExecutionTime = time.Since(start)
	return rs, nil
}

func (d *mongoDriver) Kind() driver.DriverKind { return driver.DriverMongoDB }

func (d *mongoDriver) ServerVersion() string { return d.serverVersion }

func validateOperationAllowed(op mongoOperation, readOnly bool) error {
	if readOnly && op.IsWrite() {
		return fmt.Errorf("mongodb: read-only connection blocks %s", op.Kind)
	}
	if readOnly && op.Kind == opCommand && isDestructiveCommand(op.Command) {
		return fmt.Errorf("mongodb: read-only connection blocks raw command %s", op.Command[0].Key)
	}
	return nil
}

func isDestructiveCommand(cmd bson.D) bool {
	if len(cmd) == 0 {
		return false
	}
	switch strings.ToLower(cmd[0].Key) {
	case "insert", "update", "delete", "findandmodify",
		"create", "createindexes", "drop", "dropdatabase", "dropindexes",
		"renamecollection", "collmod", "createuser", "updateuser", "dropuser",
		"grantrolestouser", "revokerolesfromuser", "setfeaturecompatibilityversion":
		return true
	default:
		return false
	}
}

func (d *mongoDriver) executeOperation(ctx context.Context, op mongoOperation) (*driver.ResultSet, error) {
	db := d.client.Database(op.Database)
	coll := db.Collection(op.Collection)

	switch op.Kind {
	case opFind:
		opts := options.Find()
		opts.SetLimit(effectiveFindLimit(op.Limit))
		if op.Skip > 0 {
			opts.SetSkip(op.Skip)
		}
		if op.Sort != nil {
			opts.SetSort(toBSONDocument(op.Sort))
		}
		if op.Projection != nil {
			opts.SetProjection(toBSONDocument(op.Projection))
		}
		cur, err := coll.Find(ctx, toBSONDocument(op.Filter), opts)
		if err != nil {
			return nil, fmt.Errorf("mongodb: find: %w", err)
		}
		defer cur.Close(ctx)
		var docs []bson.M
		if err := cur.All(ctx, &docs); err != nil {
			return nil, fmt.Errorf("mongodb: read cursor: %w", err)
		}
		return documentsToResultSet(docs, 0), nil
	case opAggregate:
		cur, err := coll.Aggregate(ctx, normalizePipeline(op.Pipeline))
		if err != nil {
			return nil, fmt.Errorf("mongodb: aggregate: %w", err)
		}
		defer cur.Close(ctx)
		var docs []bson.M
		if err := cur.All(ctx, &docs); err != nil {
			return nil, fmt.Errorf("mongodb: read cursor: %w", err)
		}
		return documentsToResultSet(docs, 0), nil
	case opCountDocuments:
		n, err := coll.CountDocuments(ctx, toBSONDocument(op.Filter))
		if err != nil {
			return nil, fmt.Errorf("mongodb: countDocuments: %w", err)
		}
		return writeSummaryResult(0, 0, map[string]any{"count": n}), nil
	case opEstimatedDocumentCount:
		n, err := coll.EstimatedDocumentCount(ctx)
		if err != nil {
			return nil, fmt.Errorf("mongodb: estimatedDocumentCount: %w", err)
		}
		return writeSummaryResult(0, 0, map[string]any{"count": n}), nil
	case opDistinct:
		var vals []any
		if err := coll.Distinct(ctx, op.DistinctField, toBSONDocument(op.Filter)).Decode(&vals); err != nil {
			return nil, fmt.Errorf("mongodb: distinct: %w", err)
		}
		docs := make([]bson.M, 0, len(vals))
		for _, val := range vals {
			docs = append(docs, bson.M{"value": val})
		}
		return documentsToResultSet(docs, 0), nil
	case opCommand:
		var doc bson.M
		if err := db.RunCommand(ctx, op.Command).Decode(&doc); err != nil {
			return nil, fmt.Errorf("mongodb: runCommand: %w", err)
		}
		return documentsToResultSet([]bson.M{doc}, 0), nil
	case opInsertOne:
		res, err := coll.InsertOne(ctx, normalizeBSONValue(op.Documents[0]))
		if err != nil {
			return nil, fmt.Errorf("mongodb: insertOne: %w", err)
		}
		return writeSummaryResult(1, 0, map[string]any{"insertedId": mongoCellValue(res.InsertedID)}), nil
	case opInsertMany:
		docs := make([]any, len(op.Documents))
		for i, doc := range op.Documents {
			docs[i] = normalizeBSONValue(doc)
		}
		res, err := coll.InsertMany(ctx, docs)
		if err != nil {
			return nil, fmt.Errorf("mongodb: insertMany: %w", err)
		}
		return writeSummaryResult(int64(len(res.InsertedIDs)), 0, map[string]any{"insertedCount": len(res.InsertedIDs)}), nil
	case opUpdateOne:
		res, err := coll.UpdateOne(ctx, toBSONDocument(op.Filter), toBSONDocument(op.Update))
		if err != nil {
			return nil, fmt.Errorf("mongodb: updateOne: %w", err)
		}
		return writeSummaryResult(res.ModifiedCount, 0, map[string]any{"matchedCount": res.MatchedCount, "modifiedCount": res.ModifiedCount}), nil
	case opUpdateMany:
		res, err := coll.UpdateMany(ctx, toBSONDocument(op.Filter), toBSONDocument(op.Update))
		if err != nil {
			return nil, fmt.Errorf("mongodb: updateMany: %w", err)
		}
		return writeSummaryResult(res.ModifiedCount, 0, map[string]any{"matchedCount": res.MatchedCount, "modifiedCount": res.ModifiedCount}), nil
	case opReplaceOne:
		res, err := coll.ReplaceOne(ctx, toBSONDocument(op.Filter), normalizeBSONValue(op.Replacement))
		if err != nil {
			return nil, fmt.Errorf("mongodb: replaceOne: %w", err)
		}
		return writeSummaryResult(res.ModifiedCount, 0, map[string]any{"matchedCount": res.MatchedCount, "modifiedCount": res.ModifiedCount}), nil
	case opDeleteOne:
		res, err := coll.DeleteOne(ctx, toBSONDocument(op.Filter))
		if err != nil {
			return nil, fmt.Errorf("mongodb: deleteOne: %w", err)
		}
		return writeSummaryResult(res.DeletedCount, 0, map[string]any{"deletedCount": res.DeletedCount}), nil
	case opDeleteMany:
		res, err := coll.DeleteMany(ctx, toBSONDocument(op.Filter))
		if err != nil {
			return nil, fmt.Errorf("mongodb: deleteMany: %w", err)
		}
		return writeSummaryResult(res.DeletedCount, 0, map[string]any{"deletedCount": res.DeletedCount}), nil
	case opCreateIndex:
		name, err := coll.Indexes().CreateOne(ctx, mongo.IndexModel{Keys: toBSONDocument(op.IndexKeys)})
		if err != nil {
			return nil, fmt.Errorf("mongodb: createIndex: %w", err)
		}
		return writeSummaryResult(0, 0, map[string]any{"createdIndex": name}), nil
	case opDropIndex:
		if err := coll.Indexes().DropOne(ctx, op.IndexName); err != nil {
			return nil, fmt.Errorf("mongodb: dropIndex: %w", err)
		}
		return writeSummaryResult(0, 0, map[string]any{"droppedIndex": op.IndexName}), nil
	case opDrop:
		if err := coll.Drop(ctx); err != nil {
			return nil, fmt.Errorf("mongodb: drop: %w", err)
		}
		return writeSummaryResult(0, 0, map[string]any{"dropped": op.Collection}), nil
	default:
		return nil, fmt.Errorf("mongodb: unsupported operation %s", op.Kind)
	}
}

func effectiveFindLimit(limit int64) int64 {
	if limit > 0 {
		return limit
	}
	return defaultFindLimit
}

func normalizePipeline(in []any) []any {
	out := make([]any, len(in))
	for i, stage := range in {
		out[i] = normalizeBSONValue(stage)
	}
	return out
}

func mongoTypeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bson.ObjectID:
		return "ObjectId"
	case string:
		return "string"
	case bool:
		return "bool"
	case int32:
		return "int"
	case int64:
		return "long"
	case int, float32, float64:
		return "number"
	case time.Time:
		return "date"
	case bson.M, bson.D, map[string]any:
		return "object"
	case bson.A, []any:
		return "array"
	default:
		return "BSON"
	}
}

func mongoConnectionMode(cfg driver.ConnectionConfig) string {
	for _, p := range cfg.AdvancedParams {
		if p.Key == connectionModeParam && p.Enabled && p.Value == "srv" {
			return "srv"
		}
	}
	return "standard"
}

func buildURI(cfg driver.ConnectionConfig, mode string) string {
	auth := ""
	if cfg.Username != "" {
		auth = url.QueryEscape(cfg.Username)
		if cfg.Password != "" {
			auth += ":" + url.QueryEscape(cfg.Password)
		}
		auth += "@"
	}
	dbName := cfg.Database
	if dbName == "" {
		dbName = "admin"
	}
	query := url.Values{}
	if cfg.TLS {
		query.Set("tls", "true")
	}
	for _, p := range cfg.AdvancedParams {
		if !p.Enabled || p.Key == "" || p.Key == connectionModeParam {
			continue
		}
		query.Set(p.Key, p.Value)
	}
	queryString := ""
	if encoded := query.Encode(); encoded != "" {
		queryString = "?" + encoded
	}
	if mode == "srv" {
		return "mongodb+srv://" + auth + cfg.Host + "/" + dbName + queryString
	}
	port := cfg.Port
	if port == 0 {
		port = 27017
	}
	return "mongodb://" + auth + cfg.Host + ":" + strconv.Itoa(port) + "/" + dbName + queryString
}
