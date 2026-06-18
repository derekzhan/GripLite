package mongodb

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/dop251/goja"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func ParseMongoOperation(dbName, input string) (*mongoOperation, error) {
	text := strings.TrimSpace(input)
	if text == "" {
		return nil, fmt.Errorf("mongodb: empty console input")
	}
	if strings.HasPrefix(text, "{") {
		cmd, err := parseJSONCommand(text)
		if err == nil {
			return &mongoOperation{Kind: opCommand, Database: dbName, Command: cmd}, nil
		}
	}

	vm := goja.New()
	var captured *mongoOperation
	capture := func(op *mongoOperation) *mongoOperation {
		captured = op
		return op
	}

	if err := installBSONHelpers(vm); err != nil {
		return nil, err
	}
	if err := installShardingHelpers(vm, capture); err != nil {
		return nil, err
	}
	if err := vm.Set("db", databaseObject(vm, dbName, capture)); err != nil {
		return nil, fmt.Errorf("mongodb: install db: %w", err)
	}

	if _, err := vm.RunString(text); err != nil {
		return nil, fmt.Errorf("mongodb: parse shell input: %w", err)
	}
	if captured == nil {
		return nil, fmt.Errorf("mongodb: input did not produce a MongoDB operation")
	}
	return captured, nil
}

func parseJSONCommand(text string) (bson.D, error) {
	var cmd bson.D
	if err := bson.UnmarshalExtJSON([]byte(text), false, &cmd); err != nil {
		return nil, err
	}
	return cmd, nil
}

func installBSONHelpers(vm *goja.Runtime) error {
	helpers := map[string]any{
		"ObjectId":   func(s string) map[string]any { return map[string]any{"$oid": s} },
		"ISODate":    func(s string) map[string]any { return map[string]any{"$date": s} },
		"NumberInt":  func(v int32) int32 { return v },
		"NumberLong": func(v int64) int64 { return v },
		"Decimal128": func(s string) map[string]any { return map[string]any{"$numberDecimal": s} },
	}
	for name, fn := range helpers {
		if err := vm.Set(name, fn); err != nil {
			return fmt.Errorf("mongodb: install %s helper: %w", name, err)
		}
	}
	return nil
}

// installShardingHelpers exposes the `sh` global from the mongo shell. Each
// helper lowers to a single admin-database runCommand, matching what the real
// shell does (e.g. sh.shardCollection(ns, key) → admin { shardCollection, key }).
func installShardingHelpers(vm *goja.Runtime, capture func(*mongoOperation) *mongoOperation) error {
	sh := vm.NewObject()

	adminCommand := func(cmd bson.D) goja.Value {
		op := &mongoOperation{Kind: opCommand, Database: "admin", Command: cmd}
		capture(op)
		return commandResultValue(vm, op)
	}
	// argString returns the i-th argument as a string when present, else "".
	argString := func(call goja.FunctionCall, i int) string {
		v := call.Argument(i)
		if goja.IsUndefined(v) || goja.IsNull(v) {
			return ""
		}
		return v.String()
	}

	methods := map[string]func(goja.FunctionCall) goja.Value{
		// sh.shardCollection(namespace, key, unique?, options?)
		"shardCollection": func(call goja.FunctionCall) goja.Value {
			cmd := bson.D{{Key: "shardCollection", Value: argString(call, 0)}}
			if key := call.Argument(1); !goja.IsUndefined(key) && !goja.IsNull(key) {
				cmd = append(cmd, bson.E{Key: "key", Value: exportDocument(vm, key)})
			}
			if unique := call.Argument(2); !goja.IsUndefined(unique) && !goja.IsNull(unique) {
				cmd = append(cmd, bson.E{Key: "unique", Value: unique.ToBoolean()})
			}
			if opts := call.Argument(3); !goja.IsUndefined(opts) && !goja.IsNull(opts) {
				cmd = append(cmd, exportDocument(vm, opts)...)
			}
			return adminCommand(cmd)
		},
		// sh.enableSharding(database, primaryShard?)
		"enableSharding": func(call goja.FunctionCall) goja.Value {
			cmd := bson.D{{Key: "enableSharding", Value: argString(call, 0)}}
			if primary := argString(call, 1); primary != "" {
				cmd = append(cmd, bson.E{Key: "primaryShard", Value: primary})
			}
			return adminCommand(cmd)
		},
		// sh.addShard(uri, name?)
		"addShard": func(call goja.FunctionCall) goja.Value {
			cmd := bson.D{{Key: "addShard", Value: argString(call, 0)}}
			if name := argString(call, 1); name != "" {
				cmd = append(cmd, bson.E{Key: "name", Value: name})
			}
			return adminCommand(cmd)
		},
		// sh.removeShard(name)
		"removeShard": func(call goja.FunctionCall) goja.Value {
			return adminCommand(bson.D{{Key: "removeShard", Value: argString(call, 0)}})
		},
		// sh.moveChunk(namespace, query, destination)
		"moveChunk": func(call goja.FunctionCall) goja.Value {
			cmd := bson.D{{Key: "moveChunk", Value: argString(call, 0)}}
			if q := call.Argument(1); !goja.IsUndefined(q) && !goja.IsNull(q) {
				cmd = append(cmd, bson.E{Key: "find", Value: exportDocument(vm, q)})
			}
			cmd = append(cmd, bson.E{Key: "to", Value: argString(call, 2)})
			return adminCommand(cmd)
		},
		// sh.splitAt(namespace, middle)
		"splitAt": func(call goja.FunctionCall) goja.Value {
			cmd := bson.D{{Key: "split", Value: argString(call, 0)}}
			if mid := call.Argument(1); !goja.IsUndefined(mid) && !goja.IsNull(mid) {
				cmd = append(cmd, bson.E{Key: "middle", Value: exportDocument(vm, mid)})
			}
			return adminCommand(cmd)
		},
		// sh.splitFind(namespace, query)
		"splitFind": func(call goja.FunctionCall) goja.Value {
			cmd := bson.D{{Key: "split", Value: argString(call, 0)}}
			if q := call.Argument(1); !goja.IsUndefined(q) && !goja.IsNull(q) {
				cmd = append(cmd, bson.E{Key: "find", Value: exportDocument(vm, q)})
			}
			return adminCommand(cmd)
		},
		// sh.startBalancer() / sh.stopBalancer() / sh.getBalancerState()
		"startBalancer": func(goja.FunctionCall) goja.Value {
			return adminCommand(bson.D{{Key: "balancerStart", Value: 1}})
		},
		"stopBalancer": func(goja.FunctionCall) goja.Value {
			return adminCommand(bson.D{{Key: "balancerStop", Value: 1}})
		},
		"getBalancerState": func(goja.FunctionCall) goja.Value {
			return adminCommand(bson.D{{Key: "balancerStatus", Value: 1}})
		},
		"isBalancerRunning": func(goja.FunctionCall) goja.Value {
			return adminCommand(bson.D{{Key: "balancerStatus", Value: 1}})
		},
		// sh.status() — surface the cluster's sharding status document.
		"status": func(goja.FunctionCall) goja.Value {
			return adminCommand(bson.D{{Key: "listShards", Value: 1}})
		},
	}

	for name, fn := range methods {
		if err := sh.Set(name, fn); err != nil {
			return fmt.Errorf("mongodb: install sh.%s: %w", name, err)
		}
	}
	if err := vm.Set("sh", sh); err != nil {
		return fmt.Errorf("mongodb: install sh helper: %w", err)
	}
	return nil
}

// identifierRe matches a bare JS identifier — used to decide whether an unknown
// property on `db` should resolve to a collection (db.my_collection) or be
// ignored (engine internals like Symbol-ish or non-identifier keys).
var identifierRe = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

// commandResultValue wraps a captured command operation so that trailing field
// access in the shell (e.g. db.coll.stats().sharded) is recorded as a
// projection path on the operation instead of being silently dropped. Each
// property read appends to op.ResultPath and returns a fresh accessor so deeper
// chains keep working (e.g. db.coll.stats().shards.shard0001).
func commandResultValue(vm *goja.Runtime, op *mongoOperation) goja.Value {
	return vm.NewDynamicObject(&resultAccessor{vm: vm, op: op})
}

type resultAccessor struct {
	vm *goja.Runtime
	op *mongoOperation
}

func (r *resultAccessor) Get(key string) goja.Value {
	if !identifierRe.MatchString(key) {
		return goja.Undefined()
	}
	r.op.ResultPath = append(r.op.ResultPath, key)
	return r.vm.NewDynamicObject(&resultAccessor{vm: r.vm, op: r.op})
}

func (r *resultAccessor) Set(string, goja.Value) bool { return false }
func (r *resultAccessor) Delete(string) bool          { return false }
func (r *resultAccessor) Keys() []string              { return nil }
func (r *resultAccessor) Has(key string) bool         { return identifierRe.MatchString(key) }

// databaseObject models the mongo shell's `db` handle as a dynamic object so
// that property-style collection access (db.my_collection), getSiblingDB("x"),
// runCommand, adminCommand and db.stats() all work — including chains such as
// db.getSiblingDB("prm").prm_tracking_path.stats().
func databaseObject(vm *goja.Runtime, dbName string, capture func(*mongoOperation) *mongoOperation) *goja.Object {
	return vm.NewDynamicObject(&shellDB{vm: vm, dbName: dbName, capture: capture, members: map[string]goja.Value{}})
}

type shellDB struct {
	vm      *goja.Runtime
	dbName  string
	capture func(*mongoOperation) *mongoOperation
	members map[string]goja.Value // cache so member identity is stable
}

// dbMembers are the explicit (non-collection) members of a `db` handle.
var dbMembers = map[string]bool{
	"getCollection": true, "getSiblingDB": true, "getSisterDB": true,
	"runCommand": true, "adminCommand": true, "getName": true, "stats": true,
	"getCollectionNames": true, "getCollectionInfos": true, "createCollection": true,
	"dropDatabase": true, "version": true, "serverStatus": true, "hostInfo": true,
	"currentOp": true,
}

// command returns a JS function that, when called, captures a runCommand
// operation against `database` and returns it (so db.stats(), db.version() etc.
// all share one code path).
func (d *shellDB) command(cmd bson.D, database string) goja.Value {
	return d.vm.ToValue(func(goja.FunctionCall) goja.Value {
		op := &mongoOperation{Kind: opCommand, Database: database, Command: cmd}
		d.capture(op)
		return commandResultValue(d.vm, op)
	})
}

func (d *shellDB) Get(key string) goja.Value {
	if v, ok := d.members[key]; ok {
		return v
	}
	var v goja.Value
	switch key {
	case "getCollection":
		v = d.vm.ToValue(func(name string) goja.Value {
			return collectionObject(d.vm, d.dbName, name, d.capture)
		})
	case "getSiblingDB", "getSisterDB":
		v = d.vm.ToValue(func(name string) goja.Value {
			return databaseObject(d.vm, name, d.capture)
		})
	case "runCommand", "adminCommand":
		cmdDB := d.dbName
		if key == "adminCommand" {
			cmdDB = "admin"
		}
		v = d.vm.ToValue(func(call goja.FunctionCall) goja.Value {
			op := &mongoOperation{Kind: opCommand, Database: cmdDB, Command: exportDocument(d.vm, call.Argument(0))}
			d.capture(op)
			return commandResultValue(d.vm, op)
		})
	case "getName":
		name := d.dbName
		v = d.vm.ToValue(func() string { return name })
	case "stats":
		v = d.command(bson.D{{Key: "dbStats", Value: 1}}, d.dbName)
	case "getCollectionNames":
		v = d.command(bson.D{{Key: "listCollections", Value: 1}, {Key: "nameOnly", Value: true}}, d.dbName)
	case "getCollectionInfos":
		v = d.command(bson.D{{Key: "listCollections", Value: 1}}, d.dbName)
	case "createCollection":
		v = d.vm.ToValue(func(call goja.FunctionCall) goja.Value {
			cmd := bson.D{{Key: "create", Value: call.Argument(0).String()}}
			if opts := call.Argument(1); !goja.IsUndefined(opts) && !goja.IsNull(opts) {
				cmd = append(cmd, exportDocument(d.vm, opts)...)
			}
			op := &mongoOperation{Kind: opCommand, Database: d.dbName, Command: cmd}
			d.capture(op)
			return commandResultValue(d.vm, op)
		})
	case "dropDatabase":
		v = d.command(bson.D{{Key: "dropDatabase", Value: 1}}, d.dbName)
	case "version":
		v = d.command(bson.D{{Key: "buildInfo", Value: 1}}, d.dbName)
	case "serverStatus":
		v = d.command(bson.D{{Key: "serverStatus", Value: 1}}, d.dbName)
	case "hostInfo":
		v = d.command(bson.D{{Key: "hostInfo", Value: 1}}, d.dbName)
	case "currentOp":
		v = d.command(bson.D{{Key: "currentOp", Value: 1}}, "admin")
	default:
		if !identifierRe.MatchString(key) {
			return goja.Undefined()
		}
		v = collectionObject(d.vm, d.dbName, key, d.capture)
	}
	d.members[key] = v
	return v
}

func (d *shellDB) Set(string, goja.Value) bool { return false }
func (d *shellDB) Delete(string) bool          { return false }
func (d *shellDB) Keys() []string              { return nil }

func (d *shellDB) Has(key string) bool {
	return dbMembers[key] || identifierRe.MatchString(key)
}

func collectionObject(vm *goja.Runtime, dbName, coll string, capture func(*mongoOperation) *mongoOperation) *goja.Object {
	obj := vm.NewObject()
	_ = obj.Set("find", func(filter map[string]any) *goja.Object {
		return cursorObject(vm, capture(&mongoOperation{Kind: opFind, Database: dbName, Collection: coll, Filter: normalizeMap(filter)}))
	})
	_ = obj.Set("aggregate", func(call goja.FunctionCall) *goja.Object {
		return cursorObject(vm, capture(&mongoOperation{Kind: opAggregate, Database: dbName, Collection: coll, Pipeline: exportArray(call.Argument(0))}))
	})
	_ = obj.Set("countDocuments", func(filter map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opCountDocuments, Database: dbName, Collection: coll, Filter: normalizeMap(filter)})
	})
	_ = obj.Set("estimatedDocumentCount", func() *mongoOperation {
		return capture(&mongoOperation{Kind: opEstimatedDocumentCount, Database: dbName, Collection: coll})
	})
	_ = obj.Set("distinct", func(field string, filter map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opDistinct, Database: dbName, Collection: coll, DistinctField: field, Filter: filter})
	})
	_ = obj.Set("findOne", func(call goja.FunctionCall) goja.Value {
		op := &mongoOperation{
			Kind:       opFind,
			Database:   dbName,
			Collection: coll,
			Filter:     normalizeMap(argMap(vm, call.Argument(0))),
			Limit:      1,
		}
		if proj := argMap(vm, call.Argument(1)); proj != nil {
			op.Projection = normalizeMap(proj)
		}
		capture(op)
		return commandResultValue(vm, op)
	})
	// count() is deprecated in favour of countDocuments() but still widely used.
	_ = obj.Set("count", func(call goja.FunctionCall) *mongoOperation {
		return capture(&mongoOperation{Kind: opCountDocuments, Database: dbName, Collection: coll, Filter: normalizeMap(argMap(vm, call.Argument(0)))})
	})
	_ = obj.Set("insertOne", func(doc map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opInsertOne, Database: dbName, Collection: coll, Documents: []any{doc}})
	})
	_ = obj.Set("insertMany", func(docs []any) *mongoOperation {
		return capture(&mongoOperation{Kind: opInsertMany, Database: dbName, Collection: coll, Documents: docs})
	})
	_ = obj.Set("updateOne", func(filter, update map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opUpdateOne, Database: dbName, Collection: coll, Filter: filter, Update: update})
	})
	_ = obj.Set("updateMany", func(filter, update map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opUpdateMany, Database: dbName, Collection: coll, Filter: filter, Update: update})
	})
	_ = obj.Set("replaceOne", func(filter, replacement map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opReplaceOne, Database: dbName, Collection: coll, Filter: filter, Replacement: replacement})
	})
	_ = obj.Set("deleteOne", func(filter map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opDeleteOne, Database: dbName, Collection: coll, Filter: filter})
	})
	_ = obj.Set("deleteMany", func(filter map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opDeleteMany, Database: dbName, Collection: coll, Filter: filter})
	})
	_ = obj.Set("createIndex", func(call goja.FunctionCall) goja.Value {
		op := &mongoOperation{
			Kind:             opCreateIndex,
			Database:         dbName,
			Collection:       coll,
			IndexKeysOrdered: exportDocument(vm, call.Argument(0)),
		}
		if optsArg := call.Argument(1); !goja.IsUndefined(optsArg) && !goja.IsNull(optsArg) {
			for _, e := range exportDocument(vm, optsArg) {
				switch e.Key {
				case "unique":
					if b, ok := e.Value.(bool); ok {
						op.IndexUnique = b
					}
				case "name":
					if s, ok := e.Value.(string); ok {
						op.IndexNameOpt = s
					}
				}
			}
		}
		capture(op)
		return commandResultValue(vm, op)
	})
	_ = obj.Set("getIndexes", func() *mongoOperation {
		return capture(&mongoOperation{Kind: opListIndexes, Database: dbName, Collection: coll})
	})
	_ = obj.Set("getIndices", func() *mongoOperation {
		return capture(&mongoOperation{Kind: opListIndexes, Database: dbName, Collection: coll})
	})
	_ = obj.Set("dropIndex", func(name string) *mongoOperation {
		return capture(&mongoOperation{Kind: opDropIndex, Database: dbName, Collection: coll, IndexName: name})
	})
	_ = obj.Set("drop", func() *mongoOperation {
		return capture(&mongoOperation{Kind: opDrop, Database: dbName, Collection: coll})
	})
	// dropIndexes() drops every (non-_id) index via the canonical command.
	_ = obj.Set("dropIndexes", func(goja.FunctionCall) goja.Value {
		op := &mongoOperation{Kind: opCommand, Database: dbName, Command: bson.D{{Key: "dropIndexes", Value: coll}, {Key: "index", Value: "*"}}}
		capture(op)
		return commandResultValue(vm, op)
	})
	// renameCollection(target, dropTarget?) → admin renameCollection command.
	_ = obj.Set("renameCollection", func(call goja.FunctionCall) goja.Value {
		target := call.Argument(0).String()
		// A bare name keeps the same database; a "db.coll" name is used verbatim.
		if !strings.Contains(target, ".") {
			target = dbName + "." + target
		}
		cmd := bson.D{
			{Key: "renameCollection", Value: dbName + "." + coll},
			{Key: "to", Value: target},
		}
		if drop := call.Argument(1); !goja.IsUndefined(drop) && !goja.IsNull(drop) {
			cmd = append(cmd, bson.E{Key: "dropTarget", Value: drop.ToBoolean()})
		}
		op := &mongoOperation{Kind: opCommand, Database: "admin", Command: cmd}
		capture(op)
		return commandResultValue(vm, op)
	})
	// collection.stats() → collStats command (includes sharding info such as the
	// `sharded` flag and per-shard breakdown). Trailing field access in the shell
	// (e.g. .stats().sharded) is captured as a projection path so only that
	// nested value is surfaced instead of the full stats document.
	stats := func(goja.FunctionCall) goja.Value {
		op := &mongoOperation{Kind: opCommand, Database: dbName, Command: bson.D{{Key: "collStats", Value: coll}}}
		capture(op)
		return commandResultValue(vm, op)
	}
	_ = obj.Set("stats", stats)
	_ = obj.Set("getShardDistribution", stats)
	return obj
}

func cursorObject(vm *goja.Runtime, op *mongoOperation) *goja.Object {
	cur := vm.NewObject()
	_ = cur.Set("sort", func(sort map[string]any) *goja.Object {
		op.Sort = normalizeMap(sort)
		return cur
	})
	_ = cur.Set("project", func(projection map[string]any) *goja.Object {
		op.Projection = normalizeMap(projection)
		return cur
	})
	_ = cur.Set("skip", func(v int64) *goja.Object {
		op.Skip = v
		return cur
	})
	_ = cur.Set("limit", func(v int64) *goja.Object {
		op.Limit = v
		return cur
	})
	_ = cur.Set("toArray", func() *mongoOperation {
		return op
	})
	// count()/size()/itcount() turn the cursor into a count of the matched docs.
	countFn := func() *mongoOperation {
		op.Kind = opCountDocuments
		return op
	}
	_ = cur.Set("count", countFn)
	_ = cur.Set("size", countFn)
	_ = cur.Set("itcount", countFn)
	// Chainable cursor modifiers we don't model — accept and ignore them so a
	// chain like find().pretty() or find().hint({...}).batchSize(100) still runs
	// instead of throwing "not a function".
	passthrough := func(goja.FunctionCall) goja.Value { return cur }
	for _, name := range []string{
		"pretty", "hint", "collation", "comment", "batchSize", "maxTimeMS",
		"allowDiskUse", "readPref", "readConcern", "noCursorTimeout", "min", "max",
		"returnKey", "showRecordId", "tailable", "addOption", "maxAwaitTimeMS",
	} {
		_ = cur.Set(name, passthrough)
	}
	return cur
}

// argMap exports a goja value to a Go map, or nil when absent / not an object.
// Used by helpers with optional document arguments (findOne, count, …).
func argMap(vm *goja.Runtime, v goja.Value) map[string]any {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return nil
	}
	if m, ok := v.Export().(map[string]any); ok {
		return m
	}
	return nil
}

func exportArray(v goja.Value) []any {
	if goja.IsUndefined(v) || goja.IsNull(v) {
		return []any{}
	}
	if a, ok := v.Export().([]any); ok {
		return a
	}
	return []any{}
}

func normalizeMap(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = normalizeBSONValue(v)
	}
	return out
}

func exportDocument(vm *goja.Runtime, v goja.Value) bson.D {
	if goja.IsUndefined(v) || goja.IsNull(v) {
		return bson.D{}
	}
	obj := v.ToObject(vm)
	keys := obj.Keys()
	out := make(bson.D, 0, len(keys))
	for _, key := range keys {
		out = append(out, bson.E{Key: key, Value: normalizeBSONValue(obj.Get(key).Export())})
	}
	return out
}

func toBSONDocument(m map[string]any) bson.D {
	out := make(bson.D, 0, len(m))
	for k, v := range m {
		out = append(out, bson.E{Key: k, Value: normalizeBSONValue(v)})
	}
	return out
}

func normalizeBSONValue(v any) any {
	switch x := v.(type) {
	case map[string]any:
		if oid, ok := x["$oid"].(string); ok {
			if id, err := bson.ObjectIDFromHex(oid); err == nil {
				return id
			}
		}
		if ds, ok := x["$date"].(string); ok {
			if t, err := time.Parse(time.RFC3339, ds); err == nil {
				return t
			}
		}
		return toBSONDocument(x)
	case []any:
		for i := range x {
			x[i] = normalizeBSONValue(x[i])
		}
		return x
	default:
		return x
	}
}
