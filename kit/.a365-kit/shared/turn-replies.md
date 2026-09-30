# Turn replies: refusals are answers, errors stay in the log

When a model refuses a prompt, or a content filter blocks it, the SDKs raise an exception. A
jailbreak or prompt-injection attempt does this on purpose, so it is a normal outcome, not a
fault. Without handling, the hosts the onboarding skills generate turn it into an error:

| Host | What the user saw |
|---|---|
| Python, `add-messaging-endpoint` | "Sorry - I hit an error working that out. Please try again." |
| Python, AI Teammate | The SDK's default: `Exception caught : <the raw error>` |
| Node.js and .NET, AI Teammate and `add-messaging-endpoint` | An apology followed by the raw error message. The Node.js agent's own handler sent `Error: <the raw error>`. |

The rule for every host:

- A refusal, a content-filter block or a tripped guardrail gets a plain refusal as the reply.
- Any other failure gets a short apology. The error text, stack and ids go to the log only.

## What each SDK raises

| SDK | Model refuses or output filtered | Azure OpenAI prompt shield (HTTP 400 `content_filter`) |
|---|---|---|
| openai-agents (Python) 0.20.0 | `ModelRefusalError` | `openai.BadRequestError`, `code == "content_filter"` |
| agent-framework 1.17.0 with agent-framework-openai 1.14.2 | No exception: empty text, `finish_reason == "content_filter"` | `OpenAIContentFilterException` |
| @openai/agents (Node.js) 0.17.0 and 0.18.0 | `ModelRefusalError` | API error with `code === 'content_filter'` |
| Azure.AI.OpenAI 2.7.0-beta.2 with Microsoft.Extensions.AI.OpenAI (.NET) | No exception: empty text, `FinishReason == ContentFilter` | `ClientResultException`, message `HTTP 400 (: content_filter)` |

Each row was captured from the real package against a local model endpoint that answered with
each of these responses. The helpers below classify all of them, and send an ordinary HTTP 400
to the apology instead. The kit repository tests the helpers on every build in
`build/test-turn-replies.mjs`.

## Python

Save as `turn_replies.py` beside `host_agent_server.py`.

```python
import logging

logger = logging.getLogger(__name__)

REFUSAL_REPLY = "I can't help with that request. It was blocked by a safety filter."
ERROR_REPLY = "Sorry, something went wrong on my side. Please try again in a moment."

# Raised by the OpenAI Agents SDK when the model refuses or its output is filtered, by
# Agent Framework when the provider's content filter blocks the prompt, and by guardrails.
_REFUSAL_TYPES = {
    "ModelRefusalError",
    "OpenAIContentFilterException",
    "InputGuardrailTripwireTriggered",
    "OutputGuardrailTripwireTriggered",
}


def is_refusal(error: BaseException) -> bool:
    """True when a model, a content filter or a guardrail declined the request."""
    pending, seen = [error], set()
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        if type(current).__name__ in _REFUSAL_TYPES or getattr(current, "code", None) == "content_filter":
            return True
        pending += [current.__cause__, current.__context__, *getattr(current, "exceptions", ())]
    return False


def reply_for_error(error: BaseException) -> str:
    """What the user sees when a turn fails. Never the error text itself."""
    return REFUSAL_REPLY if is_refusal(error) else ERROR_REPLY


async def send_turn_error(context, error: BaseException) -> None:
    """Adapter on_turn_error hook: keep the details in the log, send the user a plain reply."""
    logger.error("turn failed", exc_info=error)
    await context.send_activity(reply_for_error(error))
```

Set it as the adapter's error hook right after the adapter is created, and use
`reply_for_error` in any `except` around a turn:

```python
from turn_replies import reply_for_error, send_turn_error

self._adapter = CloudAdapter(connection_manager=connection_manager)
self._adapter.on_turn_error = send_turn_error
```

Agent Framework does not raise when the output is filtered, so check the result as well:

```python
if getattr(result, "finish_reason", None) == "content_filter":
    return REFUSAL_REPLY
```

## Node.js

Save as `src/turnReplies.ts`.

```typescript
export const REFUSAL_REPLY = "I can't help with that request. It was blocked by a safety filter.";
export const ERROR_REPLY = 'Sorry, something went wrong on my side. Please try again in a moment.';

// Thrown by the OpenAI Agents SDK when the model refuses, its output is filtered, or a guardrail trips.
const REFUSAL_TYPES = new Set(['ModelRefusalError', 'InputGuardrailTripwireTriggered', 'OutputGuardrailTripwireTriggered']);

/** True when a model, a content filter or a guardrail declined the request. */
export function isRefusal(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; errors?: unknown; error?: unknown };
    if (REFUSAL_TYPES.has(String(e.name)) || e.code === 'content_filter') return true;
    // Azure OpenAI's prompt shield names its policy in the message when the code is not kept.
    if (typeof e.message === 'string' && /content management policy/i.test(e.message)) return true;
    pending.push(e.cause, e.error, ...(Array.isArray(e.errors) ? e.errors : []));
  }
  return false;
}

/** What the user sees when a turn fails. Never the error text itself. */
export function replyForError(error: unknown): string {
  return isRefusal(error) ? REFUSAL_REPLY : ERROR_REPLY;
}
```

In `adapter.onTurnError`, log the error and send `replyForError(err)`.

## .NET

Save as `TurnReplies.cs`.

```csharp
public static class TurnReplies
{
    public const string Refusal = "I can't help with that request. It was blocked by a safety filter.";
    public const string Error = "Sorry, something went wrong on my side. Please try again in a moment.";

    /// <summary>True when a model or a content filter declined the request.</summary>
    public static bool IsRefusal(Exception? error)
    {
        for (var e = error; e is not null; e = e.InnerException)
        {
            if (e is AggregateException aggregate && aggregate.InnerExceptions.Any(IsRefusal)) return true;
            // The OpenAI and Azure OpenAI clients keep the service's error code in the message.
            if (e.Message.Contains("content_filter", StringComparison.OrdinalIgnoreCase) ||
                e.Message.Contains("content management policy", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    /// <summary>What the user sees when a turn fails. Never the error text itself.</summary>
    public static string For(Exception error) => IsRefusal(error) ? Refusal : Error;
}
```

In `OnTurnError`, log the exception and send `TurnReplies.For(exception)`. When the reply is
built from a chat response rather than streamed, send `TurnReplies.Refusal` if the response's
`FinishReason` is `ChatFinishReason.ContentFilter` and its text is empty.
