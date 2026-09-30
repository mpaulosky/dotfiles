---
description: 'Blazor component and application patterns'
applyTo: '**/*.razor, **/*.razor.cs, **/*.razor.css'
---

# Blazor Instructions

IssueTracker's UI is a Blazor Server app (`src/UI/IssueTracker.UI`) on .NET 10 and C# 14.
`CLAUDE.md` at the repository root describes the project; if this file and it disagree, it wins.

## Structure

- `Pages/` holds routable pages, `Components/` reusable pieces such as `IssueComponent` and `CommentComponent`,
  and `Shared/` the layout, login display and authorization redirects.
- Components keep markup in `.razor` and logic in a `.razor.cs` code-behind partial class. Keep `@code` blocks out of
  new components.
- Get services with `@inject` at the top of the `.razor` file, as the existing components do. Never `new` them up.
- Register new services in the matching `Extensions/Register*.cs` file, not in `Program.cs`.

## Rendering

- `Pages/_Host.cshtml` hosts the app and `MapBlazorHub` serves it, so every component is interactive over the SignalR circuit.
- Load data in `OnInitializedAsync` or `OnParametersSetAsync`, not in constructors.
- Don't call JavaScript interop during initialization or prerendering: do first-load interop in `OnAfterRenderAsync`,
  guarding one-time setup with `if (firstRender)`. Event handlers can call it freely, as `Index.razor.cs` does when it
  saves the filters to session storage.
- Implement `IDisposable` or `IAsyncDisposable` to release event subscriptions, timers, and `CancellationTokenSource`s.

## Data

- Components call the services in `IssueTracker.Services` (`IIssueService`, `ICommentService`, and so on).
  Never inject a repository or anything from MongoDB into a component. No test catches this, so reviews must.
- Components display the CoreBusiness models (`IssueModel`, `BasicUserModel`, ...). Forms bind to the DTOs in the UI's
  `Models/` folder (`CreateIssueDto`, `CreateCommentDto`), so UI-only fields and validation stay out of CoreBusiness.

## Forms and validation

- Use `EditForm` bound to a DTO, `<DataAnnotationsValidator />`, and Radzen validators (`RadzenRequiredValidator`,
  `RadzenLengthValidator`) where the form uses Radzen inputs.
- Validate again in the service before acting on a submission. Never trust client-side validation alone.

## Security

- Authentication is Azure AD B2C through Microsoft.Identity.Web. `Shared/LoginDisplay.razor` links to the
  `MicrosoftIdentity/Account/SignIn` and `SignOut` endpoints.
- Protect pages with `@attribute [Authorize]`, adding `Policy = "Admin"` for admin pages as `Admin.razor` does.
  `<AuthorizeView>` only shows or hides UI and isn't a security boundary.
- Get the signed-in user with `AuthenticationStateProviderHelpers.GetUserFromAuth`, which loads the matching `UserModel`.

## Styling

- Use Radzen.Blazor components for grids, buttons and inputs, and Bootstrap classes for layout.
- Put site-wide rules in `wwwroot/css/site.css` and Bootstrap overrides in `wwwroot/css/bootstrap-overrides.css`.
- Use `.razor.css` isolation for styles that belong to one component. Avoid inline `style` attributes.

## Testing

- Test components with bUnit in `tests/IssueTracker.UI.Tests.Unit`, following the Tests section of `CLAUDE.md`.
- Test classes derive from `BunitContext`, not bUnit's obsolete `TestContext`.
