package mongodb

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestMongoIDFilterParsesObjectIDHex(t *testing.T) {
	filter, err := mongoIDFilter("507f1f77bcf86cd799439011")
	if err != nil {
		t.Fatalf("mongoIDFilter returned error: %v", err)
	}
	id, ok := filter[0].Value.(bson.ObjectID)
	if !ok {
		t.Fatalf("filter _id type = %T, want bson.ObjectID", filter[0].Value)
	}
	if id.Hex() != "507f1f77bcf86cd799439011" {
		t.Fatalf("ObjectID = %s", id.Hex())
	}
}

func TestMongoSetDocumentSkipsIDAndParsesJSONValues(t *testing.T) {
	setDoc, err := mongoSetDocument(map[string]any{
		"_id":    "507f1f77bcf86cd799439011",
		"status": "active",
		"meta":   `{"tier":"gold"}`,
		"tags":   `["a","b"]`,
	})
	if err != nil {
		t.Fatalf("mongoSetDocument returned error: %v", err)
	}
	if len(setDoc) != 3 {
		t.Fatalf("set doc len = %d, want 3: %#v", len(setDoc), setDoc)
	}
	for _, e := range setDoc {
		if e.Key == "_id" {
			t.Fatalf("_id should not be included in $set")
		}
	}
}
