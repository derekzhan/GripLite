package mongodb

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestParseShellFindWithLimitAndSort(t *testing.T) {
	op, err := ParseMongoOperation("orders", `db.prm_order.find({ partner_id: { $in: [178, 276] } }).sort({ created_at: -1 }).limit(20)`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opFind || op.Database != "orders" || op.Collection != "prm_order" {
		t.Fatalf("op identity = %#v", op)
	}
	if op.Limit != 20 {
		t.Fatalf("Limit = %d, want 20", op.Limit)
	}
	if op.Filter == nil || op.Sort == nil {
		t.Fatalf("Filter/Sort not captured: %#v", op)
	}
}

func TestParseShellFindCapturesLiteralFilter(t *testing.T) {
	op, err := ParseMongoOperation("prm", `db.getCollection("prm_order").find({tno:"UUS63A0010864038016"}).limit(100)`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if got := op.Filter["tno"]; got != "UUS63A0010864038016" {
		t.Fatalf("filter tno = %#v, want literal tno", got)
	}
}

func TestParseJSONCommand(t *testing.T) {
	op, err := ParseMongoOperation("orders", `{ "find": "prm_order", "filter": { "status": "paid" } }`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCommand || op.Database != "orders" {
		t.Fatalf("op = %#v", op)
	}
	if op.Command == nil {
		t.Fatalf("Command not captured")
	}
	if op.Command[0].Key != "find" {
		t.Fatalf("first command key = %q, want find", op.Command[0].Key)
	}
}

func TestParseShellCreateIndexPreservesOrderAndOptions(t *testing.T) {
	op, err := ParseMongoOperation("prm", `db.getCollection("prm_order").createIndex({ partner_id: 1, created_at: -1 }, { unique: true, name: "idx_partner_created" })`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCreateIndex || op.Collection != "prm_order" {
		t.Fatalf("op identity = %#v", op)
	}
	if len(op.IndexKeysOrdered) != 2 {
		t.Fatalf("IndexKeysOrdered = %#v, want 2 ordered keys", op.IndexKeysOrdered)
	}
	if op.IndexKeysOrdered[0].Key != "partner_id" || op.IndexKeysOrdered[1].Key != "created_at" {
		t.Fatalf("compound index field order scrambled: %#v", op.IndexKeysOrdered)
	}
	if !op.IndexUnique {
		t.Fatalf("unique option not captured: %#v", op)
	}
	if op.IndexNameOpt != "idx_partner_created" {
		t.Fatalf("name option = %q, want idx_partner_created", op.IndexNameOpt)
	}
	if !op.IsWrite() {
		t.Fatalf("createIndex should be classified as a write op")
	}
}

func TestParseShellShardCollectionRunsAdminCommand(t *testing.T) {
	op, err := ParseMongoOperation("prm", `sh.shardCollection("prm.prm_tracking_path", { tno: "hashed" });`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCommand {
		t.Fatalf("op.Kind = %q, want command", op.Kind)
	}
	// Sharding helpers always target the admin database, regardless of the
	// console's current database.
	if op.Database != "admin" {
		t.Fatalf("op.Database = %q, want admin", op.Database)
	}
	if len(op.Command) < 2 {
		t.Fatalf("Command = %#v, want shardCollection + key", op.Command)
	}
	if op.Command[0].Key != "shardCollection" || op.Command[0].Value != "prm.prm_tracking_path" {
		t.Fatalf("first command entry = %#v, want shardCollection namespace", op.Command[0])
	}
	if op.Command[1].Key != "key" {
		t.Fatalf("second command key = %q, want key", op.Command[1].Key)
	}
	keyDoc, ok := op.Command[1].Value.(bson.D)
	if !ok || len(keyDoc) != 1 || keyDoc[0].Key != "tno" || keyDoc[0].Value != "hashed" {
		t.Fatalf("shard key = %#v, want { tno: \"hashed\" }", op.Command[1].Value)
	}
}

func TestParseShellGetSiblingDBCollectionStats(t *testing.T) {
	// The exact query from the bug report: chained getSiblingDB + property-style
	// collection access + .stats() + trailing field access.
	op, err := ParseMongoOperation("orders", `db.getSiblingDB("prm").prm_tracking_path.stats().sharded`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCommand {
		t.Fatalf("op.Kind = %q, want command", op.Kind)
	}
	// getSiblingDB("prm") must retarget the command to the prm database, not the
	// console's current "orders" database.
	if op.Database != "prm" {
		t.Fatalf("op.Database = %q, want prm", op.Database)
	}
	if len(op.Command) == 0 || op.Command[0].Key != "collStats" || op.Command[0].Value != "prm_tracking_path" {
		t.Fatalf("command = %#v, want collStats: prm_tracking_path", op.Command)
	}
	// The trailing .sharded access must be captured as a projection path so the
	// console surfaces just that boolean instead of the whole stats document.
	if len(op.ResultPath) != 1 || op.ResultPath[0] != "sharded" {
		t.Fatalf("ResultPath = %#v, want [sharded]", op.ResultPath)
	}
}

func TestParseShellCommandResultPath(t *testing.T) {
	cases := []struct {
		input string
		want  []string
	}{
		{`db.prm_order.stats().sharded`, []string{"sharded"}},
		{`db.prm_order.stats().shards.shard0001`, []string{"shards", "shard0001"}},
		{`db.serverStatus().connections.current`, []string{"connections", "current"}},
		{`db.prm_order.stats()`, nil},
	}
	for _, tc := range cases {
		op, err := ParseMongoOperation("prm", tc.input)
		if err != nil {
			t.Fatalf("ParseMongoOperation(%q) error: %v", tc.input, err)
		}
		if op.Kind != opCommand {
			t.Fatalf("%q: op.Kind = %q, want command", tc.input, op.Kind)
		}
		if len(op.ResultPath) != len(tc.want) {
			t.Fatalf("%q: ResultPath = %#v, want %#v", tc.input, op.ResultPath, tc.want)
		}
		for i := range tc.want {
			if op.ResultPath[i] != tc.want[i] {
				t.Fatalf("%q: ResultPath = %#v, want %#v", tc.input, op.ResultPath, tc.want)
			}
		}
	}
}

func TestParseShellPropertyStyleCollectionAccess(t *testing.T) {
	op, err := ParseMongoOperation("prm", `db.prm_order.find({ status: "paid" }).limit(5)`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opFind || op.Collection != "prm_order" || op.Database != "prm" {
		t.Fatalf("op identity = %#v", op)
	}
	if op.Limit != 5 {
		t.Fatalf("Limit = %d, want 5", op.Limit)
	}
}

func TestParseShellDbStats(t *testing.T) {
	op, err := ParseMongoOperation("prm", `db.stats()`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCommand || op.Database != "prm" {
		t.Fatalf("op = %#v, want prm command", op)
	}
	if op.Command[0].Key != "dbStats" {
		t.Fatalf("command = %#v, want dbStats", op.Command)
	}
}

func TestParseShellFindOneLimitsToOne(t *testing.T) {
	op, err := ParseMongoOperation("prm", `db.prm_order.findOne({ tno: "X" }, { _id: 0, tno: 1 })`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opFind || op.Collection != "prm_order" {
		t.Fatalf("op identity = %#v", op)
	}
	if op.Limit != 1 {
		t.Fatalf("Limit = %d, want 1", op.Limit)
	}
	if op.Filter["tno"] != "X" {
		t.Fatalf("filter = %#v", op.Filter)
	}
	if op.Projection == nil {
		t.Fatalf("projection not captured: %#v", op)
	}
}

func TestParseShellCollectionCount(t *testing.T) {
	op, err := ParseMongoOperation("prm", `db.prm_order.count({ status: "paid" })`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCountDocuments || op.Collection != "prm_order" {
		t.Fatalf("op = %#v, want countDocuments", op)
	}
}

func TestParseShellCursorCountAndPretty(t *testing.T) {
	// find().pretty().count() must not throw on the unmodelled .pretty() and
	// should collapse to a count of the matched documents.
	op, err := ParseMongoOperation("prm", `db.prm_order.find({ status: "paid" }).pretty().count()`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCountDocuments {
		t.Fatalf("op.Kind = %q, want countDocuments", op.Kind)
	}
	if op.Filter["status"] != "paid" {
		t.Fatalf("filter lost through chain: %#v", op.Filter)
	}
}

func TestParseShellCursorIgnoresUnmodelledModifiers(t *testing.T) {
	op, err := ParseMongoOperation("prm", `db.prm_order.find({}).hint({ tno: 1 }).batchSize(50).maxTimeMS(1000).limit(10)`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opFind || op.Limit != 10 {
		t.Fatalf("op = %#v, want find limit 10", op)
	}
}

func TestParseShellGetCollectionNames(t *testing.T) {
	op, err := ParseMongoOperation("prm", `db.getCollectionNames()`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCommand || op.Database != "prm" {
		t.Fatalf("op = %#v", op)
	}
	if op.Command[0].Key != "listCollections" {
		t.Fatalf("command = %#v, want listCollections", op.Command)
	}
}

func TestParseShellRenameCollectionUsesAdmin(t *testing.T) {
	op, err := ParseMongoOperation("prm", `db.prm_order.renameCollection("prm_order_bak", true)`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCommand || op.Database != "admin" {
		t.Fatalf("op = %#v, want admin command", op)
	}
	if op.Command[0].Key != "renameCollection" || op.Command[0].Value != "prm.prm_order" {
		t.Fatalf("command source = %#v, want prm.prm_order", op.Command[0])
	}
	if op.Command[1].Key != "to" || op.Command[1].Value != "prm.prm_order_bak" {
		t.Fatalf("command target = %#v, want prm.prm_order_bak", op.Command[1])
	}
}

func TestParseShellEnableSharding(t *testing.T) {
	op, err := ParseMongoOperation("prm", `sh.enableSharding("prm")`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCommand || op.Database != "admin" {
		t.Fatalf("op = %#v, want admin command", op)
	}
	if op.Command[0].Key != "enableSharding" || op.Command[0].Value != "prm" {
		t.Fatalf("command = %#v, want enableSharding: prm", op.Command)
	}
}

func TestParseShellGetIndexes(t *testing.T) {
	for _, input := range []string{
		`db.prm_order.getIndexes()`,
		`db.getCollection("prm_order").getIndices()`,
	} {
		op, err := ParseMongoOperation("prm", input)
		if err != nil {
			t.Fatalf("ParseMongoOperation(%q) error: %v", input, err)
		}
		if op.Kind != opListIndexes || op.Collection != "prm_order" {
			t.Fatalf("op = %#v, want listIndexes on prm_order", op)
		}
		if op.IsWrite() {
			t.Fatalf("getIndexes must be a read operation: %#v", op)
		}
	}
}

func TestWriteOperationsAreClassified(t *testing.T) {
	for _, input := range []string{
		`db.orders.insertOne({ status: "new" })`,
		`db.orders.updateOne({ _id: ObjectId("507f1f77bcf86cd799439011") }, { $set: { status: "paid" } })`,
		`db.orders.deleteMany({})`,
		`db.orders.drop()`,
	} {
		op, err := ParseMongoOperation("orders", input)
		if err != nil {
			t.Fatalf("ParseMongoOperation(%q) error: %v", input, err)
		}
		if !op.IsWrite() {
			t.Fatalf("%q classified as read: %#v", input, op)
		}
	}
}

func TestReadOnlyRejectsWriteOperation(t *testing.T) {
	op, err := ParseMongoOperation("orders", `db.orders.deleteOne({ status: "bad" })`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if err := validateOperationAllowed(*op, true); err == nil {
		t.Fatalf("validateOperationAllowed returned nil for write on read-only connection")
	}
}

func TestReadOnlyRejectsDestructiveRawCommands(t *testing.T) {
	for _, input := range []string{
		`{ "drop": "orders" }`,
		`db.runCommand({ delete: "orders", deletes: [] })`,
	} {
		op, err := ParseMongoOperation("orders", input)
		if err != nil {
			t.Fatalf("ParseMongoOperation(%q) error: %v", input, err)
		}
		if err := validateOperationAllowed(*op, true); err == nil {
			t.Fatalf("validateOperationAllowed returned nil for destructive command %q", input)
		}
	}
}
