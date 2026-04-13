# Auth0 Management API Integration Pattern

**Confidence:** medium
**Last validated:** 2026-04-02 (Sprint 5 implementation)

## Pattern

UserManagementService wraps the Auth0 Management API behind IUserManagementService.

### Key Facts
- Package: Auth0.ManagementApi 7.46.0 (in Directory.Packages.props)
- ManagementApiClient is directly instantiated in UserManagementService constructor
- NOT fully unit-testable without IManagementApiClientFactory injection — use integration tests for service layer
- PaginationInfo lives in Auth0.ManagementApi.Paging namespace

### Error Handling
- Auth0 API failures wrap in ResultErrorCode.ExternalService (= 5)
- Never expose raw Auth0 error messages to end users

### Secrets
- Auth0 Management secrets: NEVER in source code
- Local dev: User Secrets
- CI/CD: GitHub Actions secrets (AUTH0_MANAGEMENT_CLIENT_ID, AUTH0_MANAGEMENT_CLIENT_SECRET)

### CQRS Handlers
- GetUsersQuery, GetUserQuery → read-side
- AssignRoleCommand, RemoveRoleCommand → write-side
- All guarded by AdminPolicy authorization policy

### Authorization
- AdminPolicy guards ALL /admin/users routes
- Role claim remapping: Auth0ClaimsTransformation.cs (src/Web/Auth/)
