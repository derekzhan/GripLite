export namespace cache {
	
	export class CachedColumn {
	    ordinal: number;
	    name: string;
	    type: string;
	    nullable: boolean;
	    isPrimaryKey: boolean;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new CachedColumn(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ordinal = source["ordinal"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.nullable = source["nullable"];
	        this.isPrimaryKey = source["isPrimaryKey"];
	        this.comment = source["comment"];
	    }
	}
	export class CachedTableSchema {
	    found: boolean;
	    connId: string;
	    dbName: string;
	    tableName: string;
	    kind: string;
	    rowCount: number;
	    sizeBytes: number;
	    syncedAt: string;
	    comment: string;
	    engine: string;
	    charset: string;
	    collation: string;
	    autoIncrement?: number;
	    columns: CachedColumn[];
	
	    static createFrom(source: any = {}) {
	        return new CachedTableSchema(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.found = source["found"];
	        this.connId = source["connId"];
	        this.dbName = source["dbName"];
	        this.tableName = source["tableName"];
	        this.kind = source["kind"];
	        this.rowCount = source["rowCount"];
	        this.sizeBytes = source["sizeBytes"];
	        this.syncedAt = source["syncedAt"];
	        this.comment = source["comment"];
	        this.engine = source["engine"];
	        this.charset = source["charset"];
	        this.collation = source["collation"];
	        this.autoIncrement = source["autoIncrement"];
	        this.columns = this.convertValues(source["columns"], CachedColumn);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CompletionItem {
	    kind: string;
	    label: string;
	    detail: string;
	    dbName: string;
	    tableName: string;
	    isPrimaryKey: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CompletionItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.label = source["label"];
	        this.detail = source["detail"];
	        this.dbName = source["dbName"];
	        this.tableName = source["tableName"];
	        this.isPrimaryKey = source["isPrimaryKey"];
	    }
	}
	export class SyncStatus {
	    connId: string;
	    state: string;
	    tablesCount: number;
	    colsCount: number;
	    lastSyncAt: string;
	    errorMsg?: string;
	
	    static createFrom(source: any = {}) {
	        return new SyncStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connId = source["connId"];
	        this.state = source["state"];
	        this.tablesCount = source["tablesCount"];
	        this.colsCount = source["colsCount"];
	        this.lastSyncAt = source["lastSyncAt"];
	        this.errorMsg = source["errorMsg"];
	    }
	}

}

export namespace database {
	
	export class AdvancedParam {
	    key: string;
	    value: string;
	    enabled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AdvancedParam(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.value = source["value"];
	        this.enabled = source["enabled"];
	    }
	}
	export class ApplyResult {
	    deletedCount: number;
	    insertedCount: number;
	    updatedCount: number;
	    timeMs: number;
	    statements?: string[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ApplyResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.deletedCount = source["deletedCount"];
	        this.insertedCount = source["insertedCount"];
	        this.updatedCount = source["updatedCount"];
	        this.timeMs = source["timeMs"];
	        this.statements = source["statements"];
	        this.error = source["error"];
	    }
	}
	export class CachedColumn {
	    ordinal: number;
	    name: string;
	    type: string;
	    nullable: boolean;
	    isPrimaryKey: boolean;
	    extra?: string;
	    comment?: string;
	
	    static createFrom(source: any = {}) {
	        return new CachedColumn(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ordinal = source["ordinal"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.nullable = source["nullable"];
	        this.isPrimaryKey = source["isPrimaryKey"];
	        this.extra = source["extra"];
	        this.comment = source["comment"];
	    }
	}
	export class CachedTableEntry {
	    tableName: string;
	    engine: string;
	    sizeBytes: number;
	    comment: string;
	    columns?: CachedColumn[];
	
	    static createFrom(source: any = {}) {
	        return new CachedTableEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tableName = source["tableName"];
	        this.engine = source["engine"];
	        this.sizeBytes = source["sizeBytes"];
	        this.comment = source["comment"];
	        this.columns = this.convertValues(source["columns"], CachedColumn);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ChangeSet {
	    connectionId: string;
	    database: string;
	    tableName: string;
	    primaryKey: string;
	    deletedIds: any[];
	    addedRows: any[];
	    editedRows: any[];
	
	    static createFrom(source: any = {}) {
	        return new ChangeSet(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connectionId = source["connectionId"];
	        this.database = source["database"];
	        this.tableName = source["tableName"];
	        this.primaryKey = source["primaryKey"];
	        this.deletedIds = source["deletedIds"];
	        this.addedRows = source["addedRows"];
	        this.editedRows = source["editedRows"];
	    }
	}
	export class SSHConfig {
	    enabled: boolean;
	    host: string;
	    port: number;
	    user: string;
	    authType: string;
	    password: string;
	    privateKeyPath: string;
	
	    static createFrom(source: any = {}) {
	        return new SSHConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.authType = source["authType"];
	        this.password = source["password"];
	        this.privateKeyPath = source["privateKeyPath"];
	    }
	}
	export class ConnectionConfig {
	    id: string;
	    name: string;
	    kind: string;
	    host: string;
	    port: number;
	    username: string;
	    password: string;
	    database: string;
	    tls: boolean;
	    ssh: SSHConfig;
	    advancedParams: AdvancedParam[];
	
	    static createFrom(source: any = {}) {
	        return new ConnectionConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.username = source["username"];
	        this.password = source["password"];
	        this.database = source["database"];
	        this.tls = source["tls"];
	        this.ssh = this.convertValues(source["ssh"], SSHConfig);
	        this.advancedParams = this.convertValues(source["advancedParams"], AdvancedParam);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ExecResult {
	    columns: string[];
	    rows: any[];
	    rowCount: number;
	    truncated: boolean;
	    rowsAffected: number;
	    timeMs: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ExecResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columns = source["columns"];
	        this.rows = source["rows"];
	        this.rowCount = source["rowCount"];
	        this.truncated = source["truncated"];
	        this.rowsAffected = source["rowsAffected"];
	        this.timeMs = source["timeMs"];
	        this.error = source["error"];
	    }
	}

}

export namespace driver {
	
	export class AdvancedParam {
	    key: string;
	    value: string;
	    enabled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AdvancedParam(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.value = source["value"];
	        this.enabled = source["enabled"];
	    }
	}
	export class TriggerDetail {
	    name: string;
	    event: string;
	    timing: string;
	    statement: string;
	
	    static createFrom(source: any = {}) {
	        return new TriggerDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.event = source["event"];
	        this.timing = source["timing"];
	        this.statement = source["statement"];
	    }
	}
	export class ReferenceDetail {
	    name: string;
	    fromSchema: string;
	    fromTable: string;
	    fromCols: string[];
	    toCols: string[];
	    onDelete: string;
	    onUpdate: string;
	
	    static createFrom(source: any = {}) {
	        return new ReferenceDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.fromSchema = source["fromSchema"];
	        this.fromTable = source["fromTable"];
	        this.fromCols = source["fromCols"];
	        this.toCols = source["toCols"];
	        this.onDelete = source["onDelete"];
	        this.onUpdate = source["onUpdate"];
	    }
	}
	export class ForeignKeyDetail {
	    name: string;
	    columns: string[];
	    refSchema: string;
	    refTable: string;
	    refColumns: string[];
	    onDelete: string;
	    onUpdate: string;
	
	    static createFrom(source: any = {}) {
	        return new ForeignKeyDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.columns = source["columns"];
	        this.refSchema = source["refSchema"];
	        this.refTable = source["refTable"];
	        this.refColumns = source["refColumns"];
	        this.onDelete = source["onDelete"];
	        this.onUpdate = source["onUpdate"];
	    }
	}
	export class PartitionDetail {
	    name: string;
	    method: string;
	    expression: string;
	    description: string;
	    rows: number;
	
	    static createFrom(source: any = {}) {
	        return new PartitionDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.method = source["method"];
	        this.expression = source["expression"];
	        this.description = source["description"];
	        this.rows = source["rows"];
	    }
	}
	export class ConstraintDetail {
	    name: string;
	    type: string;
	    columns: string[];
	    expression: string;
	
	    static createFrom(source: any = {}) {
	        return new ConstraintDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.columns = source["columns"];
	        this.expression = source["expression"];
	    }
	}
	export class IndexDetail {
	    name: string;
	    type: string;
	    unique: boolean;
	    columns: string[];
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new IndexDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.unique = source["unique"];
	        this.columns = source["columns"];
	        this.comment = source["comment"];
	    }
	}
	export class AdvancedTableProperties {
	    schema: string;
	    table: string;
	    ddl: string;
	    indexes: IndexDetail[];
	    constraints: ConstraintDetail[];
	    partitions: PartitionDetail[];
	    foreignKeys: ForeignKeyDetail[];
	    references: ReferenceDetail[];
	    triggers: TriggerDetail[];
	
	    static createFrom(source: any = {}) {
	        return new AdvancedTableProperties(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.table = source["table"];
	        this.ddl = source["ddl"];
	        this.indexes = this.convertValues(source["indexes"], IndexDetail);
	        this.constraints = this.convertValues(source["constraints"], ConstraintDetail);
	        this.partitions = this.convertValues(source["partitions"], PartitionDetail);
	        this.foreignKeys = this.convertValues(source["foreignKeys"], ForeignKeyDetail);
	        this.references = this.convertValues(source["references"], ReferenceDetail);
	        this.triggers = this.convertValues(source["triggers"], TriggerDetail);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ColumnDraft {
	    originalName: string;
	    name: string;
	    type: string;
	    notNull: boolean;
	    autoIncrement: boolean;
	    default: string;
	    hasDefault: boolean;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new ColumnDraft(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.originalName = source["originalName"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.notNull = source["notNull"];
	        this.autoIncrement = source["autoIncrement"];
	        this.default = source["default"];
	        this.hasDefault = source["hasDefault"];
	        this.comment = source["comment"];
	    }
	}
	export class SSHTunnelConfig {
	    host: string;
	    port: number;
	    user: string;
	    authType: string;
	    privateKeyPath: string;
	    password: string;
	
	    static createFrom(source: any = {}) {
	        return new SSHTunnelConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.authType = source["authType"];
	        this.privateKeyPath = source["privateKeyPath"];
	        this.password = source["password"];
	    }
	}
	export class ConnectionConfig {
	    id: string;
	    name: string;
	    comment: string;
	    kind: string;
	    host: string;
	    port: number;
	    username: string;
	    password: string;
	    database: string;
	    connectTimeout: number;
	    maxOpenConns: number;
	    tls: boolean;
	    sshTunnel?: SSHTunnelConfig;
	    advancedParams?: AdvancedParam[];
	    readOnly: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.comment = source["comment"];
	        this.kind = source["kind"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.username = source["username"];
	        this.password = source["password"];
	        this.database = source["database"];
	        this.connectTimeout = source["connectTimeout"];
	        this.maxOpenConns = source["maxOpenConns"];
	        this.tls = source["tls"];
	        this.sshTunnel = this.convertValues(source["sshTunnel"], SSHTunnelConfig);
	        this.advancedParams = this.convertValues(source["advancedParams"], AdvancedParam);
	        this.readOnly = source["readOnly"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class EventInfo {
	    name: string;
	    status: string;
	    schedule: string;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new EventInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.status = source["status"];
	        this.schedule = source["schedule"];
	        this.comment = source["comment"];
	    }
	}
	
	export class IndexDraft {
	    originalName: string;
	    name: string;
	    type: string;
	    unique: boolean;
	    columns: string[];
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new IndexDraft(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.originalName = source["originalName"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.unique = source["unique"];
	        this.columns = source["columns"];
	        this.comment = source["comment"];
	    }
	}
	export class IndexChangeRequest {
	    schema: string;
	    table: string;
	    oldIndexes: IndexDraft[];
	    newIndexes: IndexDraft[];
	
	    static createFrom(source: any = {}) {
	        return new IndexChangeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.table = source["table"];
	        this.oldIndexes = this.convertValues(source["oldIndexes"], IndexDraft);
	        this.newIndexes = this.convertValues(source["newIndexes"], IndexDraft);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

	export class ConstraintDraft {
	    originalName: string;
	    name: string;
	    type: string;
	    columns: string[];
	    expression: string;
	
	    static createFrom(source: any = {}) {
	        return new ConstraintDraft(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.originalName = source["originalName"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.columns = source["columns"];
	        this.expression = source["expression"];
	    }
	}
	export class ConstraintChangeRequest {
	    schema: string;
	    table: string;
	    oldConstraints: ConstraintDraft[];
	    newConstraints: ConstraintDraft[];
	
	    static createFrom(source: any = {}) {
	        return new ConstraintChangeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.table = source["table"];
	        this.oldConstraints = this.convertValues(source["oldConstraints"], ConstraintDraft);
	        this.newConstraints = this.convertValues(source["newConstraints"], ConstraintDraft);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PartitionDraft {
	    originalName: string;
	    name: string;
	    definition: string;
	
	    static createFrom(source: any = {}) {
	        return new PartitionDraft(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.originalName = source["originalName"];
	        this.name = source["name"];
	        this.definition = source["definition"];
	    }
	}
	export class PartitionChangeRequest {
	    schema: string;
	    table: string;
	    oldPartitions: PartitionDraft[];
	    newPartitions: PartitionDraft[];
	
	    static createFrom(source: any = {}) {
	        return new PartitionChangeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.table = source["table"];
	        this.oldPartitions = this.convertValues(source["oldPartitions"], PartitionDraft);
	        this.newPartitions = this.convertValues(source["newPartitions"], PartitionDraft);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	
	export class RoutineInfo {
	    name: string;
	    type: string;
	    returnType: string;
	    comment: string;
	    created: string;
	    modified: string;
	
	    static createFrom(source: any = {}) {
	        return new RoutineInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.returnType = source["returnType"];
	        this.comment = source["comment"];
	        this.created = source["created"];
	        this.modified = source["modified"];
	    }
	}
	
	export class SchemaChangeStatement {
	    kind: string;
	    summary: string;
	    sql: string;
	
	    static createFrom(source: any = {}) {
	        return new SchemaChangeStatement(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.summary = source["summary"];
	        this.sql = source["sql"];
	    }
	}
	export class SchemaChangePreview {
	    statements: SchemaChangeStatement[];
	    warnings: string[];
	
	    static createFrom(source: any = {}) {
	        return new SchemaChangePreview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.statements = this.convertValues(source["statements"], SchemaChangeStatement);
	        this.warnings = source["warnings"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TableInfoDraft {
	    name: string;
	    engine: string;
	    collation: string;
	    charset: string;
	    autoIncrement?: number;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new TableInfoDraft(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.engine = source["engine"];
	        this.collation = source["collation"];
	        this.charset = source["charset"];
	        this.autoIncrement = source["autoIncrement"];
	        this.comment = source["comment"];
	    }
	}
	export class SchemaChangeRequest {
	    schema: string;
	    table: string;
	    originalInfo: TableInfoDraft;
	    updatedInfo: TableInfoDraft;
	    oldColumns: ColumnDraft[];
	    newColumns: ColumnDraft[];
	
	    static createFrom(source: any = {}) {
	        return new SchemaChangeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.table = source["table"];
	        this.originalInfo = this.convertValues(source["originalInfo"], TableInfoDraft);
	        this.updatedInfo = this.convertValues(source["updatedInfo"], TableInfoDraft);
	        this.oldColumns = this.convertValues(source["oldColumns"], ColumnDraft);
	        this.newColumns = this.convertValues(source["newColumns"], ColumnDraft);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SchemaChangeResult {
	    success: boolean;
	    executedCount: number;
	    statements: SchemaChangeStatement[];
	    failedIndex: number;
	    failedStatement: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new SchemaChangeResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.executedCount = source["executedCount"];
	        this.statements = this.convertValues(source["statements"], SchemaChangeStatement);
	        this.failedIndex = source["failedIndex"];
	        this.failedStatement = source["failedStatement"];
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class TableInfo {
	    name: string;
	    schema: string;
	    kind: string;
	    rowCount: number;
	    sizeBytes: number;
	    comment: string;
	    engine: string;
	    charset: string;
	    collation: string;
	    autoIncrement?: number;
	
	    static createFrom(source: any = {}) {
	        return new TableInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.schema = source["schema"];
	        this.kind = source["kind"];
	        this.rowCount = source["rowCount"];
	        this.sizeBytes = source["sizeBytes"];
	        this.comment = source["comment"];
	        this.engine = source["engine"];
	        this.charset = source["charset"];
	        this.collation = source["collation"];
	        this.autoIncrement = source["autoIncrement"];
	    }
	}
	

}

export namespace main {
	
	export class BuildInfo {
	    name: string;
	    version: string;
	    buildDate: string;
	    platform: string;
	    goVersion: string;
	    license: string;
	    author: string;
	    email: string;
	    homepage: string;
	
	    static createFrom(source: any = {}) {
	        return new BuildInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.version = source["version"];
	        this.buildDate = source["buildDate"];
	        this.platform = source["platform"];
	        this.goVersion = source["goVersion"];
	        this.license = source["license"];
	        this.author = source["author"];
	        this.email = source["email"];
	        this.homepage = source["homepage"];
	    }
	}
	export class ColumnMeta {
	    name: string;
	    type: string;
	    nullable: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ColumnMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.nullable = source["nullable"];
	    }
	}
	export class ConnectResult {
	    connectionId: string;
	    serverVersion: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connectionId = source["connectionId"];
	        this.serverVersion = source["serverVersion"];
	        this.error = source["error"];
	    }
	}
	export class ConnectionInfo {
	    id: string;
	    name: string;
	    kind: string;
	    host: string;
	    port: number;
	    database: string;
	    serverVersion: string;
	    connected: boolean;
	    color: string;
	    readOnly: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.database = source["database"];
	        this.serverVersion = source["serverVersion"];
	        this.connected = source["connected"];
	        this.color = source["color"];
	        this.readOnly = source["readOnly"];
	    }
	}
	export class QueryHistoryItem {
	    id: number;
	    connId: string;
	    dbName: string;
	    sql: string;
	    execMs: number;
	    errorMsg: string;
	    executedAt: string;
	
	    static createFrom(source: any = {}) {
	        return new QueryHistoryItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.connId = source["connId"];
	        this.dbName = source["dbName"];
	        this.sql = source["sql"];
	        this.execMs = source["execMs"];
	        this.errorMsg = source["errorMsg"];
	        this.executedAt = source["executedAt"];
	    }
	}
	export class QueryResult {
	    columns: ColumnMeta[];
	    rows: any[][];
	    rowCount: number;
	    truncated: boolean;
	    rowsAffected: number;
	    execMs: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new QueryResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columns = this.convertValues(source["columns"], ColumnMeta);
	        this.rows = source["rows"];
	        this.rowCount = source["rowCount"];
	        this.truncated = source["truncated"];
	        this.rowsAffected = source["rowsAffected"];
	        this.execMs = source["execMs"];
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace store {
	
	export class AdvancedParam {
	    key: string;
	    value: string;
	    enabled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AdvancedParam(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.value = source["value"];
	        this.enabled = source["enabled"];
	    }
	}
	export class SSHConfig {
	    enabled: boolean;
	    host: string;
	    port: number;
	    user: string;
	    authType: string;
	    password: string;
	    privateKeyPath: string;
	
	    static createFrom(source: any = {}) {
	        return new SSHConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.authType = source["authType"];
	        this.password = source["password"];
	        this.privateKeyPath = source["privateKeyPath"];
	    }
	}
	export class SavedConnection {
	    id: string;
	    name: string;
	    comment: string;
	    kind: string;
	    host: string;
	    port: number;
	    username: string;
	    password: string;
	    database: string;
	    tls: boolean;
	    ssh: SSHConfig;
	    advancedParams: AdvancedParam[];
	    readOnly: boolean;
	    color: string;
	    createdAt: string;
	    updatedAt: string;
	
	    static createFrom(source: any = {}) {
	        return new SavedConnection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.comment = source["comment"];
	        this.kind = source["kind"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.username = source["username"];
	        this.password = source["password"];
	        this.database = source["database"];
	        this.tls = source["tls"];
	        this.ssh = this.convertValues(source["ssh"], SSHConfig);
	        this.advancedParams = this.convertValues(source["advancedParams"], AdvancedParam);
	        this.readOnly = source["readOnly"];
	        this.color = source["color"];
	        this.createdAt = source["createdAt"];
	        this.updatedAt = source["updatedAt"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

