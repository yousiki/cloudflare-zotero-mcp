import type { ZoteroItem, ZoteroItemData } from '../zotero/types.js';
import type { SemanticIndex, SemanticMatch, SemanticQueryOptions } from './types.js';

/** Anything that turns text into vectors. Workers AI is the only implementation today. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export class WorkersAiEmbedder implements Embedder {
  /** bge-m3 is multilingual and outputs 1024 dimensions. */
  readonly dimensions = 1024;

  constructor(
    private readonly ai: Ai,
    private readonly model = '@cf/baai/bge-m3',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = (await this.ai.run(
      this.model as keyof AiModels,
      {
        text: texts,
      } as never,
    )) as unknown as { data: number[][] };
    if (!response?.data?.length) {
      throw new Error(`Embedding model ${this.model} returned no vectors`);
    }
    return response.data;
  }
}

/** Item types that are never worth embedding on their own. */
const SKIPPED_TYPES = new Set(['attachment', 'annotation', 'note']);

/** Vectorize rejects a delete carrying more than 100 ids (error 40007). */
const DELETE_CHUNK = 100;
/** Embedding batch size — driven by the Workers AI call, not by Vectorize. */
const EMBED_CHUNK = 25;

export function isIndexable(item: ZoteroItem): boolean {
  return !SKIPPED_TYPES.has(String(item.data.itemType)) && !item.data.deleted;
}

/**
 * The text we embed. Abstracts dominate the signal, but title, venue and tags
 * matter for short queries, so everything goes in one passage.
 */
export function embeddingText(data: ZoteroItemData): string {
  const creators = (data.creators ?? [])
    .map((creator) => creator.lastName ?? creator.name ?? '')
    .filter(Boolean)
    .slice(0, 8)
    .join(', ');
  const tags = (data.tags ?? []).map((tag) => tag.tag).join(', ');

  return [
    data.title ?? '',
    creators,
    String(data.date ?? '').match(/\d{4}/)?.[0] ?? '',
    data.publicationTitle ?? data.bookTitle ?? data.proceedingsTitle ?? data.publisher ?? '',
    tags,
    String(data.abstractNote ?? '').slice(0, 4000),
  ]
    .filter((part) => String(part).trim().length > 0)
    .join('\n')
    .slice(0, 6000);
}

/** Kept small on purpose: Vectorize allows 10 KiB of metadata per vector. */
export function embeddingMetadata(item: ZoteroItem): Record<string, string | number> {
  const data = item.data;
  const creators = (data.creators ?? [])
    .map((creator) => creator.lastName ?? creator.name ?? '')
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
  return {
    key: item.key,
    title: String(data.title ?? '').slice(0, 300),
    creators: creators.slice(0, 120),
    year: Number(String(data.date ?? '').match(/\d{4}/)?.[0] ?? 0),
    itemType: String(data.itemType ?? ''),
  };
}

export class VectorizeSemanticIndex implements SemanticIndex {
  constructor(
    private readonly index: Vectorize,
    private readonly embedder: Embedder,
  ) {}

  async query(text: string, options: SemanticQueryOptions = {}): Promise<SemanticMatch[]> {
    const [vector] = await this.embedder.embed([text]);
    if (!vector) return [];

    const filter: Record<string, unknown> = {};
    // Filtering needs a metadata index on the field; see the README setup steps.
    if (options.itemType && !options.itemType.startsWith('-')) {
      filter.itemType = { $eq: options.itemType };
    }
    if (options.fromYear || options.toYear) {
      filter.year = {
        ...(options.fromYear ? { $gte: options.fromYear } : {}),
        ...(options.toYear ? { $lte: options.toYear } : {}),
      };
    }

    const result = await this.index.query(vector, {
      // topK is capped at 50 when metadata comes back.
      topK: Math.min(options.topK ?? 10, 50),
      returnMetadata: 'all',
      ...(Object.keys(filter).length > 0
        ? { filter: filter as VectorizeVectorMetadataFilter }
        : {}),
    });

    return result.matches.map((match) => {
      const metadata = (match.metadata ?? {}) as Record<string, unknown>;
      return {
        itemKey: String(metadata.key ?? match.id),
        score: match.score,
        title: metadata.title ? String(metadata.title) : undefined,
        creators: metadata.creators ? String(metadata.creators) : undefined,
        year: metadata.year ? String(metadata.year) : undefined,
        itemType: metadata.itemType ? String(metadata.itemType) : undefined,
      };
    });
  }

  async size(): Promise<number> {
    const info = await this.index.describe();
    return info.vectorCount ?? 0;
  }

  /** Embeds and upserts in Vectorize-sized batches. Returns how many landed. */
  async upsertItems(items: ZoteroItem[]): Promise<number> {
    const indexable = items.filter(isIndexable);
    if (indexable.length === 0) return 0;

    let written = 0;
    // Small embedding batches keep each Workers AI call well inside its limits.
    for (let offset = 0; offset < indexable.length; offset += EMBED_CHUNK) {
      const batch = indexable.slice(offset, offset + EMBED_CHUNK);
      const vectors = await this.embedder.embed(batch.map((item) => embeddingText(item.data)));
      await this.index.upsert(
        batch.map((item, position) => ({
          id: item.key,
          values: vectors[position] as number[],
          metadata: embeddingMetadata(item),
        })),
      );
      written += batch.length;
    }
    return written;
  }

  async removeItems(keys: string[]): Promise<void> {
    // Vectorize rejects more than 100 ids per delete (error 40007).
    for (let offset = 0; offset < keys.length; offset += DELETE_CHUNK) {
      await this.index.deleteByIds(keys.slice(offset, offset + DELETE_CHUNK));
    }
  }
}
