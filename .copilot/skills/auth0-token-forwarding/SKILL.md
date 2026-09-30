# Skill: Auth0 Token Forwarding to Backend APIs

**Category:** Security / Authentication  
**Difficulty:** Intermediate  
**Prerequisites:** Auth0 OIDC configured in frontend, JWT Bearer auth in backend API  

## Problem

When a Blazor Server or ASP.NET Core web application uses Auth0 OIDC for user authentication, the frontend obtains an `access_token` that must be forwarded to backend API calls. Without automatic token propagation, API requests fail with 401 Unauthorized even when the user is logged in.

## Solution Pattern

Use a `DelegatingHandler` to automatically attach the user's access token to all outgoing HttpClient requests.

### Step 1: Create TokenForwardingHandler

Create `Services/TokenForwardingHandler.cs`:

```csharp
// Copyright (c) 2026. All rights reserved.

using Microsoft.AspNetCore.Authentication;

namespace YourProject.Services;

/// <summary>
/// A DelegatingHandler that forwards the Auth0 access token to outgoing API requests.
/// Attaches the Bearer token from the current user's authentication session.
/// </summary>
public sealed class TokenForwardingHandler : DelegatingHandler
{
    private readonly IHttpContextAccessor _httpContextAccessor;

    /// <summary>
    /// Initializes a new instance of <see cref="TokenForwardingHandler"/>.
    /// </summary>
    public TokenForwardingHandler(IHttpContextAccessor httpContextAccessor)
    {
        _httpContextAccessor = httpContextAccessor;
    }

    /// <inheritdoc />
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        var httpContext = _httpContextAccessor.HttpContext;
        if (httpContext is not null)
        {
            var accessToken = await httpContext.GetTokenAsync("access_token");
            if (!string.IsNullOrEmpty(accessToken))
            {
                request.Headers.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
            }
        }

        return await base.SendAsync(request, cancellationToken);
    }
}
```

### Step 2: Register Handler and Attach to HttpClients

In `Program.cs`:

```csharp
// Register IHttpContextAccessor (required by the handler)
builder.Services.AddHttpContextAccessor();

// Register the handler as transient
builder.Services.AddTransient<TokenForwardingHandler>();

// Attach to HttpClient registrations
builder.Services.AddHttpClient<IApiClient, ApiClient>(client =>
    client.BaseAddress = new Uri("https+http://api"))
    .AddServiceDiscovery()
    .AddHttpMessageHandler<TokenForwardingHandler>();
```

Repeat `.AddHttpMessageHandler<TokenForwardingHandler>()` for **all HttpClient registrations** that call protected APIs.

### Step 3: Ensure Auth0 Saves Tokens

In your Auth0 configuration (e.g., `Extensions/AuthExtensions.cs`), ensure `SaveTokens = true`:

```csharp
builder.Services.AddAuth0WebAppAuthentication(options =>
{
    options.Domain = domain;
    options.ClientId = clientId;
    options.ClientSecret = clientSecret;
    options.SaveTokens = true;  // CRITICAL: Enables GetTokenAsync("access_token")
});
```

## How It Works

1. User logs in via Auth0 OIDC → Auth0 returns an `access_token` (JWT)
2. ASP.NET Core saves the token in the authentication cookie (because `SaveTokens = true`)
3. Blazor component makes an API call via injected `IApiClient`
4. `TokenForwardingHandler` intercepts the outgoing HttpClient request
5. Handler retrieves the token via `httpContext.GetTokenAsync("access_token")`
6. Handler attaches it as `Authorization: Bearer {token}` header
7. Backend API validates the JWT and authorizes the request

## When to Use

✅ **Use this pattern when:**

- Frontend uses OIDC (Auth0, Azure AD, IdentityServer) for user login
- Backend API uses JWT Bearer authentication
- Frontend and backend are separate projects/processes
- User identity must propagate from frontend to backend

❌ **Don't use when:**

- Frontend and backend use the same authentication mechanism (e.g., both use cookie auth)
- Using Client Credentials flow (no user context — use named HttpClient with auth header instead)
- Token is obtained differently (e.g., from a secure cache or vault)

## Testing

### Manual Verification

1. Set breakpoint in `TokenForwardingHandler.SendAsync`
2. Log in as a user via `/auth/login`
3. Trigger an API call from a Blazor component
4. Verify `accessToken` is populated and attached to request

### Integration Test Pattern

```csharp
[Fact]
public async Task TokenForwardingHandler_AttachesTokenWhenPresent()
{
    // Arrange
    var httpContextAccessor = Substitute.For<IHttpContextAccessor>();
    var httpContext = new DefaultHttpContext();
    httpContext.Request.Scheme = "https";
    httpContext.Request.Host = new HostString("localhost");
    
    // Mock GetTokenAsync
    var authService = Substitute.For<IAuthenticationService>();
    authService.GetTokenAsync(Arg.Any<HttpContext>(), "access_token")
        .Returns("fake-jwt-token");
    httpContext.RequestServices = new ServiceCollection()
        .AddSingleton(authService)
        .BuildServiceProvider();
    
    httpContextAccessor.HttpContext.Returns(httpContext);
    
    var handler = new TokenForwardingHandler(httpContextAccessor)
    {
        InnerHandler = new TestMessageHandler()
    };
    var invoker = new HttpMessageInvoker(handler);
    
    // Act
    var response = await invoker.SendAsync(new HttpRequestMessage(HttpMethod.Get, "https://api/test"), default);
    
    // Assert
    var request = ((TestMessageHandler)handler.InnerHandler).LastRequest;
    request.Headers.Authorization.Should().NotBeNull();
    request.Headers.Authorization.Scheme.Should().Be("Bearer");
    request.Headers.Authorization.Parameter.Should().Be("fake-jwt-token");
}
```

## Common Pitfalls

### ❌ SaveTokens = false (default)

**Symptom:** `GetTokenAsync("access_token")` returns null  
**Fix:** Set `SaveTokens = true` in Auth0 configuration

### ❌ Forgot to register IHttpContextAccessor

**Symptom:** NullReferenceException in TokenForwardingHandler constructor  
**Fix:** Add `builder.Services.AddHttpContextAccessor();`

### ❌ Handler not attached to HttpClient

**Symptom:** API calls return 401 even when user is logged in  
**Fix:** Chain `.AddHttpMessageHandler<TokenForwardingHandler>()` to HttpClient registration

### ❌ Circular dependency (handler depends on HttpClient)

**Symptom:** InvalidOperationException at runtime  
**Fix:** Handler must **not** inject or depend on any HttpClient — use `IHttpContextAccessor` only

## Security Considerations

✅ **Handler fails gracefully** — if no token is present, request proceeds without Authorization header  
✅ **No token leakage** — token is only attached to outgoing API requests, not logged or exposed  
✅ **Works with Aspire Service Discovery** — handler runs after service discovery resolves the API endpoint  
⚠️ **Token lifetime** — access tokens expire (typically 1 hour). Implement refresh logic or re-login UX if needed.

## References

- [ASP.NET Core HttpClient DelegatingHandler](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/http-requests#outgoing-request-middleware)
- [Auth0 ASP.NET Core SDK](https://github.com/auth0/auth0-aspnetcore-authentication)
- [SaveTokens Documentation](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.authentication.remoteauthenticationoptions.savetokens)

## Example Implementations

- **IssueManager:** `src/Web/Services/TokenForwardingHandler.cs` (this project)
- Microsoft Docs: [Token Management Patterns](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/additional-scenarios#attach-tokens-to-outgoing-requests)
