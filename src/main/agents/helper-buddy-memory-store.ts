import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  HelperBuddyMemoryMetadata,
  HelperBuddyMemorySaveInput,
  HelperBuddyMemoryToolPort,
} from './types';

const MEMORY_FORMAT_HEADER = '<!-- buddy-helper-memory-v1 -->';
const MEMORY_CONTENT_MARKER = '<!-- buddy-helper-memory-content -->';
const MAX_MEMORY_NAME_CHARS = 120;
const MAX_MEMORY_USAGE_CHARS = 8_000;
const MAX_MEMORY_CONTENT_BYTES = 512 * 1024;

interface StoredMemory extends HelperBuddyMemoryMetadata {
  content: string;
  markdown: string;
}

/**
 * Durable, shared helper memory. Each record is a standalone Markdown file so
 * filesystem helpers can inspect the directory with ordinary read-only tools;
 * all mutations still go through this service for validation and atomicity.
 */
export class HelperBuddyMemoryStore implements HelperBuddyMemoryToolPort {
  readonly directory: string;
  private initialized = false;
  private readonly mutations = new Map<string, Promise<void>>();

  constructor(directory: string) {
    this.directory = directory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    this.initialized = true;
    try {
      await this.list();
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }

  async list(): Promise<HelperBuddyMemoryMetadata[]> {
    this.assertInitialized();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const markdownEntries = entries.filter((entry) => entry.name.endsWith('.md'));
    const memories = await Promise.all(
      markdownEntries.map(async (entry) => {
        if (!entry.isFile()) throw new Error(`memory entry is not a regular file: ${entry.name}`);
        const memory = await this.readMemoryFile(entry.name);
        await chmod(memory.path, 0o600);
        const expectedFileName = memoryFileName(memory.name);
        if (expectedFileName !== entry.name) {
          throw new Error(
            `memory file name does not match its declared name: ${entry.name} (expected ${expectedFileName})`,
          );
        }
        return metadata(memory);
      }),
    );
    return memories.sort((left, right) => left.name.localeCompare(right.name));
  }

  async save(input: HelperBuddyMemorySaveInput): Promise<HelperBuddyMemoryMetadata> {
    this.assertInitialized();
    const validated = validateSaveInput(input);
    const key = canonicalName(validated.name);
    return this.exclusive(key, async () => {
      const fileName = memoryFileName(validated.name);
      const markdown = renderMemoryMarkdown(validated);
      const path = join(this.directory, fileName);
      const temporaryPath = join(this.directory, `.${fileName}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporaryPath, path);
        await chmod(path, 0o600);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      return { name: validated.name, usage: validated.usage, fileName, path };
    });
  }

  async load(name: string): Promise<string> {
    this.assertInitialized();
    const normalizedName = validateName(name);
    const key = canonicalName(normalizedName);
    return this.exclusive(key, async () => {
      const memory = await this.readMemoryFile(memoryFileName(normalizedName));
      if (canonicalName(memory.name) !== key)
        throw new Error(`memory not found: ${normalizedName}`);
      return memory.markdown;
    });
  }

  async delete(name: string): Promise<void> {
    this.assertInitialized();
    const normalizedName = validateName(name);
    const key = canonicalName(normalizedName);
    await this.exclusive(key, async () => {
      const fileName = memoryFileName(normalizedName);
      await this.readMemoryFile(fileName);
      await rm(join(this.directory, fileName));
    });
  }

  private async readMemoryFile(fileName: string): Promise<StoredMemory> {
    const path = join(this.directory, fileName);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`memory entry is not a regular file: ${fileName}`);
      const markdown = await readFile(path, 'utf8');
      const parsed = parseMemoryMarkdown(markdown, fileName);
      return { ...parsed, fileName, path, markdown };
    } catch (error) {
      if (isMissingFile(error)) {
        throw new Error(`memory not found: ${basename(fileName, '.md')}`, { cause: error });
      }
      throw error;
    }
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.mutations.get(key) === tail) this.mutations.delete(key);
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('helper memory store is not initialized');
  }
}

function validateSaveInput(input: HelperBuddyMemorySaveInput): HelperBuddyMemorySaveInput {
  const name = validateName(input.name);
  if (typeof input.usage !== 'string') throw new Error('memory usage is required');
  if (typeof input.content !== 'string') throw new Error('memory content is required');
  const usage = input.usage.trim();
  const content = input.content.trim();
  if (usage.length === 0) throw new Error('memory usage is required');
  if (usage.includes('\0')) throw new Error('memory usage must not contain null bytes');
  if (usage.length > MAX_MEMORY_USAGE_CHARS)
    throw new Error(
      `memory usage must be at most ${MAX_MEMORY_USAGE_CHARS.toLocaleString()} characters`,
    );
  if (content.length === 0) throw new Error('memory content is required');
  if (content.includes('\0')) throw new Error('memory content must not contain null bytes');
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_CONTENT_BYTES)
    throw new Error(
      `memory content must be at most ${MAX_MEMORY_CONTENT_BYTES.toLocaleString()} UTF-8 bytes`,
    );
  return { name, usage, content };
}

function validateName(value: string): string {
  if (typeof value !== 'string') throw new Error('memory name is required');
  const name = value.normalize('NFKC').trim();
  if (name.length === 0) throw new Error('memory name is required');
  if (name.length > MAX_MEMORY_NAME_CHARS)
    throw new Error(`memory name must be at most ${MAX_MEMORY_NAME_CHARS} characters`);
  if (/\p{Cc}/u.test(name)) throw new Error('memory name must not contain control characters');
  return name;
}

function canonicalName(name: string): string {
  return name.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function memoryFileName(name: string): string {
  const canonical = canonicalName(name);
  const slug = canonical
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return `${slug || 'memory'}-${digest}.md`;
}

function renderMemoryMarkdown(input: HelperBuddyMemorySaveInput): string {
  return [
    MEMORY_FORMAT_HEADER,
    `<memory_name>${escapeXml(input.name)}</memory_name>`,
    `<memory_usage>${escapeXml(input.usage)}</memory_usage>`,
    '',
    MEMORY_CONTENT_MARKER,
    '',
    input.content,
    '',
  ].join('\n');
}

function parseMemoryMarkdown(
  markdown: string,
  fileName: string,
): Pick<StoredMemory, 'name' | 'usage' | 'content'> {
  const header = new RegExp(
    `^${escapeRegExp(MEMORY_FORMAT_HEADER)}\\n<memory_name>([\\s\\S]*?)<\\/memory_name>\\n<memory_usage>([\\s\\S]*?)<\\/memory_usage>\\n\\n${escapeRegExp(MEMORY_CONTENT_MARKER)}\\n\\n([\\s\\S]*?)\\n?$`,
  ).exec(markdown);
  if (!header) throw new Error(`invalid helper memory format: ${fileName}`);
  const name = validateName(unescapeXml(header[1] ?? ''));
  const usage = unescapeXml(header[2] ?? '').trim();
  const content = (header[3] ?? '').trim();
  return validateSaveInput({ name, usage, content });
}

function metadata(memory: StoredMemory): HelperBuddyMemoryMetadata {
  return {
    name: memory.name,
    usage: memory.usage,
    fileName: memory.fileName,
    path: memory.path,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
