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
	db := vm.NewObject()
	if err := db.Set("getCollection", func(name string) *goja.Object {
		return collectionObject(vm, dbName, name, capture)
	}); err != nil {
		return nil, fmt.Errorf("mongodb: install getCollection: %w", err)
	}
	if err := db.Set("runCommand", func(call goja.FunctionCall) goja.Value {
		op := &mongoOperation{Kind: opCommand, Database: dbName, Command: exportDocument(vm, call.Argument(0))}
		capture(op)
		return vm.ToValue(op)
	}); err != nil {
		return nil, fmt.Errorf("mongodb: install runCommand: %w", err)
	}
	vm.Set("db", db)

	if _, err := vm.RunString(rewriteDotCollectionAccess(text)); err != nil {
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

func rewriteDotCollectionAccess(input string) string {
	re := regexp.MustCompile(`\bdb\.([A-Za-z_][A-Za-z0-9_]*)\b`)
	return re.ReplaceAllStringFunc(input, func(match string) string {
		name := strings.TrimPrefix(match, "db.")
		if name == "getCollection" || name == "runCommand" {
			return match
		}
		return `db.getCollection("` + name + `")`
	})
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
		return vm.ToValue(op)
	})
	_ = obj.Set("dropIndex", func(name string) *mongoOperation {
		return capture(&mongoOperation{Kind: opDropIndex, Database: dbName, Collection: coll, IndexName: name})
	})
	_ = obj.Set("drop", func() *mongoOperation {
		return capture(&mongoOperation{Kind: opDrop, Database: dbName, Collection: coll})
	})
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
	return cur
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
