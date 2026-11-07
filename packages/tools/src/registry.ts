import { type AnyTool, type ToolDefinition, jsonSchemaFor, wireName } from './define.ts';
import type * as z from 'zod/v4';

export interface ToolSpecOut {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly specCache = new Map<string, ToolSpecOut>();

  register<I extends z.ZodType, O>(tool: ToolDefinition<I, O>): this {
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} is already registered`);
    this.tools.set(tool.name, tool as unknown as AnyTool);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(toolsets?: string[]): AnyTool[] {
    const all = [...this.tools.values()];
    return toolsets ? all.filter((t) => toolsets.includes(t.toolset)) : all;
  }

  toolsets(): string[] {
    return [...new Set([...this.tools.values()].map((t) => t.toolset))].sort();
  }

  /** Stable order (sorted by name) so tool schemas stay byte-identical for prompt caching. */
  specs(toolsets?: string[]): ToolSpecOut[] {
    return this.list(toolsets)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        let spec = this.specCache.get(t.name);
        if (!spec) {
          spec = { name: wireName(t.name), description: t.description, parameters: jsonSchemaFor(t.input) };
          this.specCache.set(t.name, spec);
        }
        return spec;
      });
  }
}
