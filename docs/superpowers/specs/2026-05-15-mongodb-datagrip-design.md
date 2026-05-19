# MongoDB DataGrip-Style Support Design

## Goal

Add MongoDB support to GripLite with a DataGrip-like workflow:

- Create and save MongoDB connections, including regular host/port connections and MongoDB Atlas SRV connections.
- Open a MongoDB console that accepts Mongo Shell / DataGrip Playground style input, while also accepting raw JSON command documents.
- Show MongoDB databases and collections in the existing explorer.
- Double-click a collection to open its data, with `Grid`, `Record`, and `Text` display modes.

The selected implementation approach is scheme C: embed a controlled JavaScript runtime for Mongo Shell style expressions, backed by the official Go MongoDB driver for all actual database operations.

## Current Project Context

GripLite is a Wails + React app. The backend exposes exported methods from `app.go` to the frontend. MySQL support is organized around:

- `internal/driver/types.go`, which already defines driver-agnostic abstractions and includes `DriverMongoDB` and `ObjectCollection`.
- `internal/driver/mysql`, which implements the current `DatabaseDriver`.
- `internal/store`, which persists connection records with encrypted passwords.
- `frontend/src/components/ConnectionDialog.jsx`, `DatabaseExplorer.jsx`, `SqlEditor.jsx`, `ResultPanel.jsx`, `TableViewer.jsx`, and `DataViewer.jsx`, which implement the existing MySQL connection, console, explorer, and data display flows.

The MongoDB feature should reuse these boundaries where possible instead of creating a separate application path.

## MySQL Non-Regression Requirement

MongoDB support must be additive. Existing MySQL behavior is the baseline and must not change unless a change is explicitly required for backend dispatch:

- Existing MySQL saved connections, connection testing, SQL console execution, schema explorer, table double-click, table properties, inline data editing, schema alteration, copy/export flows, autocomplete, pagination, and query history must continue to work.
- Default connection kind remains `mysql` for old saved records and newly-created connections unless the user explicitly selects MongoDB.
- Shared frontend components must branch on connection kind only where behavior is genuinely backend-specific. MySQL should keep its current labels, SQL placeholders, table/view semantics, `WHERE` filter bar, editable table data flow, and schema designer controls.
- Shared backend methods such as `RunQuery`, `FetchDatabases`, `FetchTables`, `GetTableSchema`, and connection store methods should preserve their current MySQL request/response shapes. Any MongoDB-specific fields must be optional and ignored by MySQL callers.
- The existing `internal/driver/mysql` package should not be refactored as part of this feature except for small integration changes required to coexist with the MongoDB driver registry.

## Backend Architecture

### MongoDB Driver Package

Create `internal/driver/mongodb` and register it with the existing driver registry:

- `Kind()` returns `driver.DriverMongoDB`.
- `Connect()` opens a `mongo.Client`, validates credentials with `ping`, and stores server version/build info when available.
- `FetchDatabases()` calls `ListDatabaseNames`.
- `FetchTables()` calls `ListCollectionSpecifications` or `ListCollectionNames` and returns `driver.TableInfo` with `Kind: driver.ObjectCollection`.
- `FetchTableDetail()` samples a small number of documents from the collection, infers top-level fields and common BSON types, and fetches index metadata.
- `ExecuteQuery()` and `ExecuteQueryOnDB()` route input through the Mongo console execution layer.

The package should use the official MongoDB Go driver. Connection options should support:

- Regular URI built from host, port, username, password, auth database, TLS, and enabled advanced params.
- SRV URI built as `mongodb+srv://...`.
- `serverSelectionTimeoutMS` from existing connection timeout semantics.
- Read-only enforcement at the app/driver layer when the connection is marked read-only.

### Controlled JavaScript Runtime

Use an embedded JavaScript runtime to evaluate Mongo Shell style expressions without exposing Node.js, filesystem, network, or process APIs.

The runtime should expose only:

- `db`, bound to the active MongoDB database.
- Collection access through `db.collectionName` and `db.getCollection("collectionName")`.
- `db.runCommand(command)`.
- BSON helpers: `ObjectId()`, `ISODate()`, `NumberInt()`, `NumberLong()`, `Decimal128()` where feasible.
- Cursor-style methods for query composition: `find`, `aggregate`, `sort`, `limit`, `skip`, `project`, `count`, `countDocuments`, `estimatedDocumentCount`, `distinct`, `explain`.
- Write/admin methods for the first version because full command support was requested: `insertOne`, `insertMany`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `createIndex`, `dropIndex`, `drop`, and `runCommand`.

The JS runtime must not execute database operations directly. It should build an internal operation description, then Go executes that description through the MongoDB driver. This keeps the security boundary in Go and avoids letting arbitrary JavaScript perform side effects outside the allowed Mongo surface.

### JSON Command Mode

If console input is valid JSON or extended JSON and does not look like a JS expression, execute it as a MongoDB command document against the active database:

```json
{ "find": "prm_order", "filter": { "partner_id": { "$in": [178, 276] } } }
```

This mode should share the same result conversion and read-only checks as shell-style execution.

### Result Conversion

Return MongoDB results through the existing `QueryResult` shape:

- `columns`: inferred from `_id` and top-level document keys across the returned page.
- `rows`: values aligned to columns.
- `rowCount`: number of materialized rows.
- `truncated`: true if the driver stopped at the page/row cap.
- `rowsAffected`: populated for writes where MongoDB reports affected counts.
- `execMs`: measured wall-clock execution time.
- `error`: normalized error text for frontend display.

Values should be converted into JSON-friendly types:

- `ObjectId` as hex string by default.
- Dates as RFC3339 strings.
- Nested objects and arrays as compact JSON strings for grid cells.
- `null` preserved as null.

The original document JSON should remain available to support `Data` and `Text` modes. If the current `QueryResult` shape is too restrictive, add a Mongo-specific optional field such as `documents` while preserving existing MySQL behavior.

## Frontend Design

### Connection Dialog

Extend `ConnectionDialog.jsx` with a database type selector:

- MySQL keeps the existing fields and defaults.
- MongoDB regular mode uses host, port, username, password, authentication database, TLS, read preference, and advanced params.
- MongoDB Atlas SRV mode uses host such as `cluster.example.mongodb.net`, username, password, auth database, TLS default on, and advanced params.

The displayed URL should update to:

- `mongodb://host:port/database`
- `mongodb+srv://host/database`

Saved connections continue to use the existing store schema because it already persists `kind`, host, port, database, TLS, SSH, advanced params, read-only, and color. The MongoDB connection mode is stored as a hidden advanced param named `_gripliteMongoConnectionMode` with value `standard` or `srv`. The UI should not show this internal param in the user-editable advanced options list.

### Explorer

For MongoDB connections:

- Show databases under the existing Databases group.
- Show collections where MySQL tables/views appear.
- Render collection icons and labels using `kind === "collection"`.
- Double-clicking a collection opens a table-like data tab with MongoDB semantics.
- Database overview can reuse `DatabaseViewer` but labels should say collections rather than tables when the active connection is MongoDB.

### Console

The current SQL console should become a backend-aware console:

- MySQL connections keep SQL behavior.
- MongoDB connections use a MongoDB Playground mode.
- The editor can keep Monaco as plain JavaScript initially, with Mongo-specific examples/placeholders.
- Run behavior continues to call `RunQuery`. The backend checks the saved connection kind and dispatches MySQL input to the MySQL driver and MongoDB input to the MongoDB console executor. This keeps console tabs and result panels backend-agnostic.

Example placeholder:

```js
db.prm_order.find({ partner_id: { $in: [178, 276] } }).limit(100)
```

### Collection Data View

Double-clicking a collection opens a viewer with three modes:

- `Data`: document/record-oriented view. This maps to the current record view behavior and should show one document at a time with fields stacked vertically.
- `Grid`: table-like view using inferred top-level fields as columns.
- `Text`: pretty JSON output for the current result/page.

For collection tabs, the default query is:

```js
db.getCollection("<collection>").find({}).limit(100)
```

Filtering and sorting can start with Mongo JSON snippets rather than SQL `WHERE` clauses. Existing MySQL-only table editing and schema-alter controls should be hidden or disabled for MongoDB collections until explicit MongoDB edit flows are designed.

## Safety And Error Handling

- Read-only connections must block write/admin operations before they reach MongoDB.
- Dangerous operations such as `drop`, `dropDatabase`, broad `deleteMany({})`, and raw `runCommand` destructive commands should require a confirmation flow before execution.
- The JS runtime should run with a timeout and should not expose global APIs beyond the Mongo shell surface.
- Query execution should respect context cancellation.
- Errors should identify whether parsing, JS evaluation, connection, command execution, or BSON conversion failed.

## Testing Strategy

Backend tests:

- Existing MySQL backend tests must continue to pass unchanged.
- URI building for regular and SRV connections.
- Shell expression parsing for common find, aggregate, count, write, and runCommand calls.
- JSON command detection and execution mapping.
- Read-only blocking for write/admin operations.
- BSON-to-`QueryResult` conversion, including nested documents, arrays, dates, ObjectIds, nulls, and mixed fields.

Frontend tests:

- Existing MySQL-focused frontend/unit smoke tests must continue to pass unchanged.
- Connection dialog switches between MySQL, MongoDB regular, and MongoDB SRV modes without breaking existing MySQL fields.
- Explorer renders MongoDB collections and double-click opens a collection tab.
- Data viewer presents the same result in Data, Grid, and Text modes.

Manual verification:

- Re-run a known MySQL connection flow: connect, open SQL console, run `SELECT`, expand schemas/tables, double-click a table, switch table data modes, and confirm existing table properties still load.
- Connect to a local MongoDB instance.
- Connect to an Atlas SRV cluster.
- Run `find`, `aggregate`, `countDocuments`, `estimatedDocumentCount`, `insertOne`, `updateOne`, `deleteOne`, `createIndex`, and `runCommand`.
- Open a collection by double-click and verify all three display modes.

## Implementation Notes

This feature touches shared abstractions, so implementation should be staged:

1. Add MongoDB dependencies and backend driver skeleton.
2. Implement connection, database listing, and collection listing.
3. Implement the controlled JS execution layer and JSON command mode.
4. Convert MongoDB results into `QueryResult`.
5. Extend connection dialog and saved connection handling.
6. Adapt explorer and collection double-click behavior.
7. Adapt console and data display modes.
8. Add tests and run frontend/backend verification.
9. Run MySQL regression verification before considering the feature complete.

