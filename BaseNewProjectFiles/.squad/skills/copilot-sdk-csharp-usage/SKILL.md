# GitHub Copilot SDK for C# Skill

## Overview
Guidance for integrating the GitHub Copilot SDK into .NET 10+ applications. Covers client initialization, session management, event handling, tool definitions, and BYOK (Bring Your Own Key) provider configuration.

## When to Use
- Integrating GitHub Copilot capabilities into {ProjectName} or companion tools
- Building AI-assisted features that require real-time streaming responses
- Implementing custom tools (AIFunctionFactory) that extend Copilot's capabilities
- Using custom LLM providers (OpenAI, etc.) instead of GitHub-hosted Copilot

## Confidence
`low` — SDK is in technical preview; expect potential breaking changes

## Installation
```
dotnet add package GitHub.Copilot.SDK
```

**Requirements:**
- .NET 10.0 or later
- GitHub Copilot CLI installed and in PATH
- Uses async/await patterns throughout

## Key Patterns

### 1. Client Initialization
```csharp
await using var client = new CopilotClient();
await client.StartAsync();
```

**CopilotClientOptions:**
- `CliPath` — Path to GitHub Copilot CLI executable
- `CliArgs` — Command-line arguments for CLI
- `CliUrl`, `Port`, `UseStdio` — Connection configuration
- `LogLevel` — Logging verbosity
- `AutoStart`, `AutoRestart` — Client lifecycle management
- `Cwd`, `Environment` — Working directory and env variables
- `Logger` — Custom logger implementation

### 2. Session Management
Create and manage Copilot sessions with `SessionConfig`:

```csharp
await using var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    Streaming = true,
    SystemMessage = "You are...",
    Provider = "copilot"  // or custom provider
});
```

**SessionConfig properties:**
- `SessionId` — Unique session identifier
- `Model` — LLM model (e.g., "gpt-5")
- `Tools` — Available tools for this session
- `SystemMessage` — System prompt for the session
- `AvailableTools`, `ExcludedTools` — Tool filtering
- `Streaming` — Enable streaming responses

**Session operations:**
```csharp
// Send messages
var response = await session.SendAsync(new MessageOptions { Prompt = "..." });

// Abort ongoing requests
await session.AbortAsync();

// Retrieve message history
var messages = await session.GetMessagesAsync();

// Resume existing session
await using var resumedSession = await client.ResumeSessionAsync(sessionId, config);
```

### 3. Event Handling — Use TaskCompletionSource
**Always use TaskCompletionSource to wait for SessionIdleEvent:**

```csharp
var done = new TaskCompletionSource();

using IDisposable subscription = session.On(evt =>
{
    if (evt is AssistantMessageEvent msg)
    {
        Console.WriteLine(msg.Data.Content);
    }
    else if (evt is SessionIdleEvent)
    {
        done.SetResult();
    }
    else if (evt is SessionErrorEvent error)
    {
        done.SetException(new Exception(error.Data.Message));
    }
});

await session.SendAsync(new MessageOptions { Prompt = "..." });
await done.Task;
```

**Common events:**
- `AssistantMessageEvent` — Response content (including delta chunks if streaming)
- `SessionIdleEvent` — Session ready for new requests
- `SessionErrorEvent` — Runtime error occurred

### 4. Tool Definitions with AIFunctionFactory
Type-safe tool definitions:

```csharp
var tools = new List<AIFunction>
{
    AIFunctionFactory.Create(
        ([Description("The user's query")] string query) =>
        {
            var result = SearchDatabase(query);
            return result;
        },
        "search_database",
        "Search the database for matching records"
    ),
    AIFunctionFactory.Create(
        ([Description("Issue ID")] string issueId,
         [Description("New status")] string status) =>
        {
            UpdateIssueStatus(issueId, status);
            return "Status updated";
        },
        "update_issue",
        "Update the status of an issue"
    )
};

var session = await client.CreateSessionAsync(new SessionConfig
{
    Tools = tools
});
```

**Best practices for tool definitions:**
- Use `[Description(...)]` for all parameters
- Provide descriptive tool names and descriptions
- Return serializable results
- Keep tool logic focused and side-effect aware

### 5. BYOK (Bring Your Own Key) / Custom Provider
Use custom LLM providers:

```csharp
var providerConfig = new ProviderConfig
{
    Type = "openai",
    BaseUrl = "https://api.openai.com/v1",
    ApiKey = "sk-..." // from config/secrets, never hardcoded
};

var session = await client.CreateSessionAsync(new SessionConfig
{
    Provider = "openai",
    ProviderConfig = providerConfig,
    // ... other config
});
```

**Supported provider types:**
- `"copilot"` — GitHub-hosted Copilot (default)
- `"openai"` — OpenAI API
- Custom provider types as configured

### 6. Client State & Connectivity
```csharp
// Check connection state
if (client.State == ClientState.Connected)
{
    // Ready for operations
}

// Verify connectivity
var pong = await client.PingAsync("test");
```

### 7. Session Lifecycle
```csharp
// List all sessions
var sessions = await client.ListSessionsAsync();

// Delete session
await client.DeleteSessionAsync(sessionId);
```

## Best Practices

1. **Always use `await using`** — Ensures proper resource cleanup via IAsyncDisposable
2. **Use TaskCompletionSource for event handling** — Don't block threads; await completion properly
3. **Handle SessionErrorEvent** — Robust error handling for production systems
4. **Use pattern matching** — Switch expressions for event handling
5. **Enable streaming** — Better UX for long responses
6. **Use AIFunctionFactory** — Type-safe tool definitions
7. **Dispose event subscriptions** — Unsubscribe when no longer needed
8. **Preserve safety guardrails** — Use `SystemMessageMode.Append` to keep Copilot's default behaviors
9. **Provide descriptive tool metadata** — Clear names and descriptions aid LLM decision-making
10. **Handle both delta and final events** — When streaming, process incremental updates and final responses

## Gotchas

1. **Technical preview** — SDK may introduce breaking changes; review release notes before upgrading
2. **IAsyncDisposable requirement** — Must use `await using`, not synchronous `using`
3. **CLI dependency** — GitHub Copilot CLI must be installed and accessible in PATH
4. **TaskCompletionSource pattern** — Don't use direct event awaits; use TaskCompletionSource
5. **Streaming fragmentation** — Delta events contain partial content; reassemble for complete messages
6. **Tool call execution** — SDK invokes tools; ensure tool implementations handle errors gracefully
7. **Session state** — Sessions are stateful; avoid concurrent operations on the same session
8. **Resource exhaustion** — Create new sessions intentionally; don't leak them

## References

- [GitHub Copilot SDK Documentation](https://github.com/github/copilot-extensions)
- [GitHub Copilot CLI](https://github.com/github/copilot-cli)
- [.NET Async/Await Best Practices](https://learn.microsoft.com/en-us/archive/msdn-magazine/2013/march/async-await-best-practices-in-asynchronous-programming)
- [StreamJsonRpc Documentation](https://github.com/microsoft/vs-streamjsonrpc)
