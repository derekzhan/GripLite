package mongodb

import "go.mongodb.org/mongo-driver/v2/bson"

type operationKind string

const (
	opFind                   operationKind = "find"
	opAggregate              operationKind = "aggregate"
	opCountDocuments         operationKind = "countDocuments"
	opEstimatedDocumentCount operationKind = "estimatedDocumentCount"
	opDistinct               operationKind = "distinct"
	opInsertOne              operationKind = "insertOne"
	opInsertMany             operationKind = "insertMany"
	opUpdateOne              operationKind = "updateOne"
	opUpdateMany             operationKind = "updateMany"
	opReplaceOne             operationKind = "replaceOne"
	opDeleteOne              operationKind = "deleteOne"
	opDeleteMany             operationKind = "deleteMany"
	opCreateIndex            operationKind = "createIndex"
	opListIndexes            operationKind = "listIndexes"
	opDropIndex              operationKind = "dropIndex"
	opDrop                   operationKind = "drop"
	opCommand                operationKind = "command"
)

type mongoOperation struct {
	Kind          operationKind
	Database      string
	Collection    string
	Filter        map[string]any
	Projection    map[string]any
	Sort          map[string]any
	Pipeline      []any
	Documents     []any
	Update        map[string]any
	Replacement   map[string]any
	Command       bson.D
	DistinctField string
	IndexKeys     map[string]any
	// IndexKeysOrdered preserves the field order of a compound index (a plain
	// map scrambles it). When set it takes precedence over IndexKeys.
	IndexKeysOrdered bson.D
	IndexUnique      bool
	IndexNameOpt     string
	IndexName        string
	Skip             int64
	Limit            int64
}

func (op mongoOperation) IsWrite() bool {
	switch op.Kind {
	case opInsertOne, opInsertMany, opUpdateOne, opUpdateMany, opReplaceOne,
		opDeleteOne, opDeleteMany, opCreateIndex, opDropIndex, opDrop:
		return true
	default:
		return false
	}
}
