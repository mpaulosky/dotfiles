# MongoDB DBA Patterns Skill

## Overview

Expert DBA administration patterns for MongoDB 7.x+ as used in IssueManager. Covers cluster management,
database/collection operations, backup/restore, performance tuning (indexes, profiling), security
(authentication, roles, TLS), and upgrade guidance. Applies to the `MongoDB.EntityFrameworkCore` driver
stack and WiredTiger storage engine.

## When to Use

- Setting up or reconfiguring a MongoDB replica set or standalone instance for local dev or production
- Creating/dropping databases or collections for IssueManager entities (Issues, Categories, Statuses, Comments)
- Running or scheduling backups with `mongodump` / `mongorestore`
- Diagnosing slow queries, missing indexes, or high memory usage
- Configuring SCRAM-SHA-256 authentication, role-based access control, or TLS/mTLS
- Planning or executing a MongoDB version upgrade (e.g., 6.x → 7.x)
- Evaluating deprecated or removed features and migrating to modern alternatives

## Confidence

`low` — first time this skill is being formally established for the project.

## Key Patterns

### Cluster and Replica Set Management

```bash
# Initiate a single-node replica set (required for transactions / EF Core change tracking)
mongosh --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] })'

# Check replica set status
mongosh --eval 'rs.status()'

# Add a secondary member
mongosh --eval 'rs.add("host2:27017")'
```

**Key principles:**

- IssueManager uses `MongoDB.EntityFrameworkCore`, which requires a replica set for multi-document transactions
- Always run `rs.status()` after topology changes before starting the application
- Use Aspire's MongoDB resource for local development; configure replica set in `AppHost`

### Database and Collection Creation

```csharp
// EF Core / MongoDB.EntityFrameworkCore — collections are created implicitly on first write.
// To create them explicitly (e.g., with schema validation), use the MongoDB C# driver:
var database = client.GetDatabase("IssueManagerDb");
await database.CreateCollectionAsync("Issues", new CreateCollectionOptions
{
    Validator = new BsonDocument("$jsonSchema", /* schema */),
    ValidationLevel = DocumentValidationLevel.Strict
});
```

**Key principles:**

- Prefer letting EF Core create collections on first use during development
- Add schema validators in staging/production to enforce document shape
- Collection names in IssueManager: `Issues`, `Categories`, `Statuses`, `Comments`

### Backup and Restore

```bash
# Full database backup
mongodump --uri="mongodb://localhost:27017" --db=IssueManagerDb --out=/backup/$(date +%F)

# Restore from backup
mongorestore --uri="mongodb://localhost:27017" --db=IssueManagerDb /backup/2026-03-03/IssueManagerDb

# Single-collection backup
mongodump --uri="mongodb://localhost:27017" --db=IssueManagerDb --collection=Issues --out=/backup/issues
```

**Key principles:**

- Schedule `mongodump` via cron; store backups off-host (Azure Blob, S3)
- Test restores on a non-production instance before relying on backups
- For Atlas clusters, use Atlas Backup (continuous) instead of `mongodump`

### Performance Tuning

```javascript
// Create a compound index to support paginated list queries
db.Issues.createIndex({ "Author.Name": 1, "CreatedAt": -1 }, { name: "idx_author_created" })

// Partial index for non-archived issues (mirrors the Archived filter in IssueRepository)
db.Issues.createIndex({ "CreatedAt": -1 }, { partialFilterExpression: { "Archived": false }, name: "idx_active_created" })

// Identify slow operations (threshold: 100ms)
db.setProfilingLevel(1, { slowms: 100 })
db.system.profile.find().sort({ ts: -1 }).limit(10).pretty()

// Explain a query
db.Issues.find({ "Archived": false }).sort({ "CreatedAt": -1 }).explain("executionStats")
```

**Key principles:**

- Every repository filter field should have a supporting index
- Use partial indexes for the `Archived: false` base filter — dramatically reduces index size
- Run `explain("executionStats")` on any query with `COLLSCAN` stage and add an index
- Disable profiling in production unless actively investigating; it adds overhead

### Security

```javascript
// Create application user with least-privilege role
use IssueManagerDb
db.createUser({
  user: "issuemanager_app",
  pwd: passwordPrompt(),   // avoid plain-text passwords in scripts
  roles: [{ role: "readWrite", db: "IssueManagerDb" }]
})

// Create read-only reporting user
db.createUser({
  user: "issuemanager_readonly",
  pwd: passwordPrompt(),
  roles: [{ role: "read", db: "IssueManagerDb" }]
})
```

**Key principles:**

- Use SCRAM-SHA-256 (default in MongoDB 4.0+); never use SCRAM-SHA-1 for new installations
- Store the connection string with credentials in User Secrets (`dotnet user-secrets`) or Azure Key Vault — never in `appsettings.json`
- Enable TLS on all non-localhost connections; set `tls=true` in the connection URI
- Apply the principle of least privilege: the app user should have `readWrite` only on `IssueManagerDb`
- Enable MongoDB auditing for production clusters to track admin operations

### Upgrades and Compatibility

```bash
# Check current feature compatibility version before upgrading
mongosh --eval 'db.adminCommand({ getParameter: 1, featureCompatibilityVersion: 1 })'

# Set FCV to current major version (run after upgrading binaries)
mongosh --eval 'db.adminCommand({ setFeatureCompatibilityVersion: "7.0", confirm: true })'
```

**Key principles:**

- Always upgrade one major version at a time (e.g., 6.0 → 7.0, not 5.0 → 7.0)
- Set FCV to current version before upgrading to next
- Verify application compatibility with `MongoDB.Driver` and `MongoDB.EntityFrameworkCore` release notes

## Tools

| Tool | Purpose |
|------|---------|
| **MongoDB Compass** | GUI for schema inspection, index management, query explain plans, aggregation builder |
| **VS Code MongoDB Extension** (MongoDB for VS Code) | Run queries, browse collections, manage connections directly from VS Code |
| **mongodump / mongorestore** | CLI backup and restore utilities |
| **mongosh** | Modern MongoDB shell for administrative commands |
| **MongoDB Atlas** | Managed cloud clusters; use Atlas Backup instead of `mongodump` on Atlas |

**Preferred workflow:** Use VS Code extension or Compass for day-to-day exploration; resort to shell commands
only when automation or scripting is required.

## MongoDB Version Notes (7.x+)

| Deprecated / Removed | Modern Alternative |
|----------------------|--------------------|
| `db.collection.ensureIndex()` | `db.collection.createIndex()` / `createIndexes` |
| MMAPv1 storage engine | WiredTiger (default since 3.2; MMAPv1 removed in 4.2) |
| `db.eval()` | Aggregation pipeline or application-side logic |
| `geoHaystack` index type | `2dsphere` index |
| `snapshot` query option | Snapshot read concern / sessions |
| `$where` with JavaScript | `$expr` with aggregation expressions |

**MongoDB.EntityFrameworkCore compatibility:**

- Requires MongoDB 5.0+ (replica set or Atlas)
- MongoDB 7.0 is the recommended minimum for IssueManager production deployments
- Check [MongoDB EF Core Provider releases](https://github.com/mongodb/mongo-efcore-provider/releases) for driver version matrix

## Gotchas

1. **Replica set required** — `MongoDB.EntityFrameworkCore` needs a replica set for multi-document
   transactions. A standalone `mongod` will throw `NotSupportedException` at runtime.
2. **FCV must match before upgrade** — Skipping `setFeatureCompatibilityVersion` causes the new binary
   to fail to start.
3. **`mongodump` is not a point-in-time backup** — On a replica set under write load, use `--oplog`
   flag to capture a consistent snapshot.
4. **Index builds block in foreground** — In MongoDB 4.2+ index builds always use the optimized
   background approach, but on large collections they still hold collection-level intent locks; schedule
   during low-traffic windows.
5. **Connection string credentials** — Never commit credentials to source control.
   Use `dotnet user-secrets` locally and Azure Key Vault in production.
6. **Driver version pinning** — `MongoDB.Driver` and `MongoDB.EntityFrameworkCore` must be compatible
   versions. Check `Directory.Packages.props` before upgrading either package.
7. **`createdAt` field timezone** — MongoDB stores dates as UTC. Ensure `DateTime` values set in C#
   are `DateTimeKind.Utc` before inserting to avoid timezone drift issues.

## References

- [MongoDB 7.0 Release Notes](https://www.mongodb.com/docs/manual/release-notes/7.0/)
- [MongoDB C# Driver Documentation](https://www.mongodb.com/docs/drivers/csharp/current/)
- [MongoDB EF Core Provider](https://www.mongodb.com/docs/entity-framework/current/)
- [Index Strategies](https://www.mongodb.com/docs/manual/applications/indexes/)
- [Role-Based Access Control](https://www.mongodb.com/docs/manual/core/authorization/)
- [mongodump / mongorestore](https://www.mongodb.com/docs/database-tools/mongodump/)
- [Replica Set Administration](https://www.mongodb.com/docs/manual/administration/replica-set-maintenance/)
- [Security Checklist](https://www.mongodb.com/docs/manual/administration/security-checklist/)
- [MongoDB for VS Code](https://www.mongodb.com/products/tools/vs-code)
