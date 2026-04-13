# Feature Implementation Pattern (CQRS + UI)

**Confidence:** medium

## Data Model
- Feature data stored as `List<string>` on the entity model — MongoDB persists as array field
- No separate collection needed — simple embedded list
- `{Entity}Dto` is a positional record — when adding new fields, update: BunitTestBase.CreateTest{Entity}(), {Entity}MapperTests, {Entity}ServiceTests, related service tests, `{Entity}Dto.Empty`

## Service Layer
- I{Feature}Service / {Feature}Service provide suggestions from existing entities
- Simple prefix-match aggregation across all entity `{Feature}` fields
- GET /api/{feature}s/suggestions?prefix={query} endpoint

## CQRS Handlers
- Add{Feature}Command: appends value (no-op if duplicate)
- Remove{Feature}Command: removes value by key
- Both publish {Entity}UpdatedEvent via MediatR, return Result<{Entity}Dto>

## Frontend
- {Feature}Input.razor: multi-value tag input
  - 300ms debounced autocomplete calling I{Feature}Service
  - Comma or Enter key confirms a tag
  - Backspace removes last tag
  - ValueChanged callback propagates List<string> to parent form
- Filter chips: URL query param (?{feature}=value1,value2) drives filter
  - NavigationManager integration for URL-state sync
  - Clicking chip toggles filter on/off

## Testing
- FakeNavigationManager MUST override NavigateToCore(string, NavigationOptions) for bUnit tests involving navigation
- Verify test counts after implementing the feature
