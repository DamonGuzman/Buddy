import type {
  HelperBuddyMemoryMetadata,
  HelperBuddyMemorySaveInput,
  HelperBuddyMemoryToolPort,
} from '../../src/main/agents/types';

/** Lightweight isolated-test implementation; persistence is covered by HelperBuddyMemoryStore tests. */
export function createTestHelperBuddyMemory(): HelperBuddyMemoryToolPort {
  const values = new Map<
    string,
    { input: HelperBuddyMemorySaveInput; metadata: HelperBuddyMemoryMetadata }
  >();
  return {
    directory: '/test/helper-memories',
    async list() {
      return [...values.values()].map(({ metadata }) => ({ ...metadata }));
    },
    async save(input) {
      const fileName = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'memory'}.md`;
      const metadata = {
        name: input.name,
        usage: input.usage,
        fileName,
        path: `/test/helper-memories/${fileName}`,
      };
      values.set(input.name.toLocaleLowerCase('en-US'), { input: { ...input }, metadata });
      return { ...metadata };
    },
    async load(name) {
      const value = values.get(name.toLocaleLowerCase('en-US'));
      if (!value) throw new Error(`memory not found: ${name}`);
      return [
        '<!-- buddy-helper-memory-v1 -->',
        `<memory_name>${value.input.name}</memory_name>`,
        `<memory_usage>${value.input.usage}</memory_usage>`,
        '',
        '<!-- buddy-helper-memory-content -->',
        '',
        value.input.content,
        '',
      ].join('\n');
    },
    async delete(name) {
      if (!values.delete(name.toLocaleLowerCase('en-US')))
        throw new Error(`memory not found: ${name}`);
    },
  };
}
