# You.com Search Integration

This directory contains examples demonstrating how to integrate You.com's search API with Deep Agents for enhanced web research capabilities.

## Overview

The You.com search integration provides high-quality web search results with source citations, offering an alternative to other search providers. It supports both authenticated and keyless usage modes.

## Files

- `tools/youcom-search.ts` - You.com search tool implementation
- `youcom-search-agent.ts` - Simple example agent using You.com search
- `research-agent.ts` - Enhanced research agent with both Tavily and You.com search options

## Setup

### Option 1: Keyless Mode (Basic)

The You.com search tool works without any API key for basic search functionality:

```typescript
import { youcomSearch } from "./tools/youcom-search.js";

// No environment variables needed for basic usage
const agent = createDeepAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
  tools: [youcomSearch],
});
```

### Option 2: Authenticated Mode (Enhanced)

For enhanced features and higher rate limits, add your You.com API key:

```bash
# Add to your .env file
YDC_API_KEY=your_youcom_api_key_here
```

Get your API key from [You.com API](https://api.you.com/?utm_source=deepagents&utm_medium=integration&utm_campaign=search_tool).

## Usage Examples

### Basic Web Search

```typescript
import { createDeepAgent } from "deepagents";
import { youcomSearch } from "./tools/youcom-search.js";

const agent = createDeepAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
  tools: [youcomSearch],
  systemPrompt: "You are a research assistant with web search capabilities.",
});

const result = await agent.invoke({
  messages: [new HumanMessage("What are the latest developments in AI?")],
});
```

### Multi-Tool Research Agent

```typescript
import { youcomSearch } from "./tools/youcom-search.js";
import { internetSearch } from "./research-agent.js"; // Tavily search

const researchAgent = createDeepAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
  tools: [internetSearch, youcomSearch], // Multiple search providers
  systemPrompt: `You have access to multiple search tools:
    - internet_search: Tavily search with topic filtering
    - youcom_search: You.com search with high-quality results`,
});
```

### Tool Parameters

The `youcom_search` tool accepts these parameters:

- `query` (string, required): The search query
- `maxResults` (number, optional, default: 5): Maximum number of results (1-20)
- `includeRawContent` (boolean, optional, default: false): Include raw content (not currently implemented)

## Features

- **High-quality results**: You.com's search API provides curated, relevant results
- **Source citations**: Results include titles, URLs, and snippets
- **Flexible authentication**: Works with or without API keys
- **Error handling**: Graceful handling of rate limits, authentication errors, and API issues
- **TypeScript support**: Full type safety with Zod schema validation

## Error Handling

The tool handles common error scenarios:

- **401 Unauthorized**: Invalid or missing API key
- **429 Rate Limited**: Too many requests (try again later or add API key)
- **402 Payment Required**: Quota exceeded (add API key for higher limits)
- **Network errors**: Connection timeouts and other network issues

## Integration with Deep Agents

The You.com search tool follows Deep Agents conventions:

- Uses the standard LangChain `tool()` function
- Includes Zod schema for parameter validation
- Returns formatted text results compatible with agent reasoning
- Handles errors gracefully without breaking agent workflows

## Running Examples

```bash
# Install dependencies
pnpm install

# Set up environment (optional for keyless mode)
cp .env.example .env
# Edit .env to add YDC_API_KEY if desired

# Run the You.com search example
npx tsx examples/research/youcom-search-agent.ts

# Run the enhanced research agent with multiple search tools
npx tsx examples/research/research-agent.ts
```

## API Reference

### You.com Search API

- **Endpoint**: `https://api.you.com/v1/agents/search`
- **Authentication**: Bearer token (optional)
- **Rate Limits**: Higher limits with API key
- **Documentation**: [You.com API Docs](https://documentation.you.com/?utm_source=deepagents&utm_medium=integration&utm_campaign=search_tool)

### Tool Schema

```typescript
{
  query: string;           // Search query
  maxResults?: number;     // Max results (1-20, default: 5)
  includeRawContent?: boolean; // Include raw content (default: false)
}
```

### Response Format

The tool returns formatted search results as text:

```
Found 5 search results for "AI developments":

1. **Latest AI Breakthroughs in 2024**
   URL: https://example.com/ai-breakthroughs
   Recent advances in AI include improved language models...

2. **AI Research Trends**
   URL: https://example.com/ai-trends
   Researchers are focusing on multimodal AI systems...
```

## Best Practices

1. **Use appropriate maxResults**: Start with 5 results, adjust based on needs
2. **Handle errors gracefully**: The tool returns error messages as strings for agent processing
3. **Combine with other tools**: Use alongside filesystem, memory, and other research tools
4. **API key management**: Use environment variables, never hardcode keys
5. **Rate limiting**: Be mindful of API limits, especially in keyless mode

## Troubleshooting

### Common Issues

**"No search results found"**
- Try rephrasing the query
- Check internet connectivity
- Verify the query is not too specific

**"Rate limit exceeded"**
- Add a YDC_API_KEY for higher limits
- Wait before retrying
- Reduce search frequency in agent workflows

**"API authentication failed"**
- Verify YDC_API_KEY is correct
- Check environment variable is loaded
- Ensure API key has proper permissions

### Support

For issues with the You.com API:
- [You.com API Documentation](https://documentation.you.com/?utm_source=deepagents&utm_medium=integration&utm_campaign=search_tool)
- [You.com Support](https://about.you.com/contact/?utm_source=deepagents&utm_medium=integration&utm_campaign=search_tool)

For Deep Agents integration issues:
- [Deep Agents GitHub Issues](https://github.com/langchain-ai/deepagentsjs/issues)
- [Deep Agents Documentation](https://docs.langchain.com/oss/javascript/deepagents)