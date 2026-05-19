package mongodb

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"GripLite/internal/database"
	"GripLite/internal/driver"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func (d *mongoDriver) ApplyChanges(ctx context.Context, cs database.ChangeSet) database.ApplyResult {
	start := time.Now()
	if d.client == nil {
		return database.ApplyResult{Error: driver.ErrNotConnected.Error()}
	}
	if d.cfg.ReadOnly {
		return database.ApplyResult{Error: "mongodb: read-only connection blocks collection edits"}
	}
	if cs.Database == "" || cs.TableName == "" {
		return database.ApplyResult{Error: "mongodb: database and collection are required"}
	}

	coll := d.client.Database(cs.Database).Collection(cs.TableName)
	var res database.ApplyResult

	for _, id := range cs.DeletedIds {
		filter, err := mongoIDFilter(id)
		if err != nil {
			return database.ApplyResult{Error: err.Error()}
		}
		r, err := coll.DeleteOne(ctx, filter)
		if err != nil {
			return database.ApplyResult{Error: fmt.Sprintf("mongodb delete: %v", err)}
		}
		res.DeletedCount += r.DeletedCount
	}

	for _, row := range cs.AddedRows {
		doc, err := mongoInsertDocument(row)
		if err != nil {
			return database.ApplyResult{Error: err.Error()}
		}
		if len(doc) == 0 {
			continue
		}
		if _, err := coll.InsertOne(ctx, doc); err != nil {
			return database.ApplyResult{Error: fmt.Sprintf("mongodb insert: %v", err)}
		}
		res.InsertedCount++
	}

	pk := cs.PrimaryKey
	if pk == "" {
		pk = "_id"
	}
	for _, patch := range cs.EditedRows {
		id, ok := patch[pk]
		if !ok {
			return database.ApplyResult{Error: fmt.Sprintf("mongodb update: missing %s", pk)}
		}
		filter, err := mongoIDFilter(id)
		if err != nil {
			return database.ApplyResult{Error: err.Error()}
		}
		setDoc, err := mongoSetDocument(patch)
		if err != nil {
			return database.ApplyResult{Error: err.Error()}
		}
		if len(setDoc) == 0 {
			continue
		}
		r, err := coll.UpdateOne(ctx, filter, bson.D{{Key: "$set", Value: setDoc}})
		if err != nil {
			return database.ApplyResult{Error: fmt.Sprintf("mongodb update: %v", err)}
		}
		res.UpdatedCount += r.ModifiedCount
	}

	res.TimeMs = time.Since(start).Milliseconds()
	return res
}

func mongoIDFilter(id any) (bson.D, error) {
	return bson.D{{Key: "_id", Value: mongoIDValue(id)}}, nil
}

func mongoInsertDocument(row map[string]any) (bson.D, error) {
	out := make(bson.D, 0, len(row))
	for key, val := range row {
		if key == "" {
			continue
		}
		if key == "_id" && (val == nil || val == "") {
			continue
		}
		if key == "_id" {
			out = append(out, bson.E{Key: key, Value: mongoIDValue(val)})
			continue
		}
		out = append(out, bson.E{Key: key, Value: mongoChangeValue(val)})
	}
	return out, nil
}

func mongoIDValue(v any) any {
	if s, ok := v.(string); ok {
		if id, err := bson.ObjectIDFromHex(strings.TrimSpace(s)); err == nil {
			return id
		}
	}
	return mongoChangeValue(v)
}

func mongoSetDocument(row map[string]any) (bson.D, error) {
	out := make(bson.D, 0, len(row))
	for key, val := range row {
		if key == "" || key == "_id" {
			continue
		}
		out = append(out, bson.E{Key: key, Value: mongoChangeValue(val)})
	}
	return out, nil
}

func mongoChangeValue(v any) any {
	switch x := v.(type) {
	case string:
		trimmed := strings.TrimSpace(x)
		if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
			var decoded any
			if err := json.Unmarshal([]byte(trimmed), &decoded); err == nil {
				return normalizeBSONValue(decoded)
			}
		}
		return x
	case map[string]any, []any:
		return normalizeBSONValue(x)
	default:
		return x
	}
}
