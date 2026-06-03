package mongodb

import "testing"

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
