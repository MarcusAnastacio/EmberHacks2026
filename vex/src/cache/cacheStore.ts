import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

const cachePrefix = 'vex.cache.';
const cacheIndexKey = 'vex.cache.index';
const maxCacheEntries = 100;

export function hashContent(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class CacheStore {
	public constructor(private readonly state: vscode.Memento) {}

	public get<T>(key: string): T | undefined {
		return this.state.get<T>(`${cachePrefix}${key}`);
	}

	public async set<T>(key: string, value: T): Promise<void> {
		const fullKey = `${cachePrefix}${key}`;
		const index = this.state.get<string[]>(cacheIndexKey, []).filter(entry => entry !== fullKey);
		index.push(fullKey);
		const evicted = index.splice(0, Math.max(0, index.length - maxCacheEntries));
		await this.state.update(fullKey, value);
		await this.state.update(cacheIndexKey, index);
		for (const entry of evicted) {
			await this.state.update(entry, undefined);
		}
	}
}
