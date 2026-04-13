# Auth0 Management API Security Patterns

**Confidence:** medium
**Last validated:** 2026-04-02 (Sprint 5 — Admin User Management)

## Secrets Management

**CRITICAL: Auth0 Management API secrets must NEVER appear in source code or committed config files.**

- Local dev: Use `dotnet user-secrets set "Auth0Management:ClientSecret" "..."` 
- CI/CD: GitHub Actions secrets (`AUTH0_MANAGEMENT_CLIENT_ID`, `AUTH0_MANAGEMENT_CLIENT_SECRET`)
- Never `Console.Write`, log, or echo secrets — even in debug paths

## Principle of Least Privilege

Request only the Management API scopes you need:
- `read:users` — reading user profiles
- `update:users` — updating user metadata
- `create:users` — creating users (only if needed)
- `read:roles` — reading role definitions
- `create:role_members` — assigning roles
- `delete:role_members` — revoking roles

## Rate Limiting

Auth0 Management API rate limits:
- Developer plan: 1,000 requests/minute
- Production: 5,000 requests/minute

**Mitigation:** Cache user lists and role assignments in IMemoryCache (5-minute TTL is reasonable for admin UI).

## Authorization Boundary

AdminPolicy MUST guard ALL routes that call IUserManagementService:
```csharp
app.MapGet("/admin/users", ...).RequireAuthorization("AdminPolicy");
```
Never allow user-role operations from non-admin endpoints.

## Error Handling

Auth0 API errors should use `ResultErrorCode.ExternalService` (= 5):
```csharp
catch (ApiException ex)
{
    return Result<T>.Failure("Auth0 API error", ResultErrorCode.ExternalService);
}
```
**Never expose raw Auth0 error messages, status codes, or SDK stack traces to end users.**

## Audit Logging

Log all admin role operations with: userId, actorId, action (assign/revoke), timestamp, roleId.
Use structured logging (not string interpolation) to avoid log injection.

## Testing

ManagementApiClient is not directly unit-testable — use:
- Integration tests for UserManagementService
- Mock IUserManagementService in command handler tests
