'use strict';

/**
 * 采集结果缓存。
 *
 * 采集层的开销主要在两处：
 *   - 读取大文件（Codex 单目录 264 MB）
 *   - 启动外部进程（DSH 每个文件一次 zstd 调用，25 ms × 23 ≈ 575 ms）
 * 而文件内容在一次会话写入之间几乎不变，因此按 (路径 + mtimeMs + size)
 * 做指纹缓存：指纹未变就复用上次的解析结果，跳过读取与解压。
 *
 * 缓存只存在内存中，进程退出即消失；不做持久化，避免陈旧数据问题。
 */

const fs = require('fs');

class ParseCache {
  constructor() {
    /** @type {Map<string, {fingerprint: string, value: any}>} */
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /** 生成文件指纹；文件不可读时返回 null。 */
  static fingerprint(file) {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  /**
   * 取缓存或按需解析。
   * @param {string} file 文件路径
   * @param {(file: string) => any} parse 解析函数
   * @returns {any} 解析结果（可能来自缓存）
   */
  get(file, parse) {
    const fp = ParseCache.fingerprint(file);
    if (fp === null) return null;

    const hit = this.entries.get(file);
    if (hit && hit.fingerprint === fp) {
      this.hits++;
      return hit.value;
    }

    this.misses++;
    const value = parse(file);
    this.entries.set(file, { fingerprint: fp, value });
    return value;
  }

  /** 清掉已不存在的文件，防止长期运行后缓存无限增长。 */
  prune(existingFiles) {
    const keep = new Set(existingFiles);
    for (const key of this.entries.keys()) {
      if (!keep.has(key)) this.entries.delete(key);
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      hitRate: total ? Math.round((this.hits / total) * 100) : 0,
    };
  }
}

module.exports = { ParseCache };
