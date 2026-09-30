import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import { reindexFts, slugify } from './inspirations.js';
import { normalizeRules, regenerateGaps, type AlbumRulesShape } from './albums.js';

export function createTag(params: {
  libraryId: string;
  domain: string;
  name: string;
  parentId?: string | null;
}): string {
  const db = getDb();
  const slug = slugify(params.name);
  const existing = db
    .prepare('SELECT id FROM tag WHERE library_id = ? AND domain = ? AND slug = ?')
    .get(params.libraryId, params.domain, slug) as { id: string } | undefined;
  if (existing) throw errors.badRequest('同域下已存在同名标签', { tagId: existing.id });

  if (params.parentId) {
    assertValidParent(params.parentId, params.libraryId, params.domain, null);
  }

  const maxOrder = (
    db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tag WHERE library_id = ? AND domain = ?')
      .get(params.libraryId, params.domain) as { m: number }
  ).m;

  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO tag (id, library_id, domain, parent_id, name, slug, is_builtin, disabled, sort_order,
       usage_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,0,?,0,?,?)`,
  ).run(id, params.libraryId, params.domain, params.parentId ?? null, params.name, slug, maxOrder + 10, ts, ts);
  return id;
}

/**
 * 校验"把标签挂到 parentId 下"是否合法：
 * 父标签必须存在、同库、同域，且不能是标签自身或其后代（否则形成父子环）。
 * tagId 为 null 表示新建场景（只需存在性/同库/同域校验）。
 */
function assertValidParent(
  parentId: string,
  libraryId: string,
  domain: string,
  tagId: string | null,
): void {
  if (tagId && parentId === tagId) {
    throw errors.badRequest('标签不能以自己为父标签（父子关系不允许成环）');
  }
  const parent = getDb().prepare('SELECT id, domain, library_id FROM tag WHERE id = ?').get(parentId) as
    | { id: string; domain: string; library_id: string }
    | undefined;
  if (!parent) throw errors.notFound('父标签');
  if (parent.library_id !== libraryId) throw errors.scopeDenied();
  if (parent.domain !== domain) throw errors.badRequest('父标签必须属于同一标签域');
  // 被移动标签已经在新父节点的祖先链上（即新父节点是它自己或其后代）时，挂上即成环
  if (tagId && chainReaches(parentId, tagId)) {
    throw errors.badRequest('不能把标签挂到自己或自己的子标签下（父子关系不允许成环）');
  }
}

/**
 * 沿 nodeId 的 parent_id 链向上走，能否碰到 ancestorId（含起点自身）。
 * visited 兜底：即使库里因历史脏数据已有环，这里也不会死循环。
 */
function chainReaches(nodeId: string, ancestorId: string): boolean {
  const db = getDb();
  let current: string | null = nodeId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    const row = db.prepare('SELECT parent_id FROM tag WHERE id = ?').get(current) as
      | { parent_id: string | null }
      | undefined;
    current = row?.parent_id ?? null;
  }
  return false;
}

export function updateTag(
  id: string,
  libraryId: string,
  patch: { name?: string; parentId?: string | null; sortOrder?: number; disabled?: boolean },
): void {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tag WHERE id = ?').get(id) as
    | {
        id: string;
        library_id: string;
        domain: string;
        is_builtin: number;
        name: string;
      }
    | undefined;
  if (!row) throw errors.notFound('标签');
  if (row.library_id !== libraryId) throw errors.scopeDenied();

  let renamed = false;
  if (patch.name !== undefined && patch.name !== row.name) {
    if (row.is_builtin) throw errors.forbiddenRole('内置标签不可改名，可停用或新增自定义标签');
    const slug = slugify(patch.name);
    const clash = db
      .prepare('SELECT id FROM tag WHERE library_id = ? AND domain = ? AND slug = ? AND id <> ?')
      .get(libraryId, row.domain, slug, id) as { id: string } | undefined;
    if (clash) throw errors.badRequest('同域下已存在同名标签', { tagId: clash.id });
    db.prepare('UPDATE tag SET name = ?, slug = ?, updated_at = ? WHERE id = ?').run(
      patch.name,
      slug,
      nowIso(),
      id,
    );
    renamed = true;
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId) assertValidParent(patch.parentId, libraryId, row.domain, id);
    db.prepare('UPDATE tag SET parent_id = ?, updated_at = ? WHERE id = ?').run(patch.parentId, nowIso(), id);
  }
  if (patch.sortOrder !== undefined) {
    db.prepare('UPDATE tag SET sort_order = ?, updated_at = ? WHERE id = ?').run(patch.sortOrder, nowIso(), id);
  }
  if (patch.disabled !== undefined) {
    db.prepare('UPDATE tag SET disabled = ?, updated_at = ? WHERE id = ?').run(
      patch.disabled ? 1 : 0,
      nowIso(),
      id,
    );
  }
  // 改名不改 id，但历史灵感 FTS 的 tags 列冗余存了标签名，必须同步重建，否则全文检索仍停在旧名字
  if (renamed) {
    const affected = db
      .prepare('SELECT inspiration_id FROM inspiration_tag WHERE tag_id = ?')
      .all(id) as { inspiration_id: string }[];
    for (const a of affected) reindexFts(a.inspiration_id);
  }
}

export interface MergeTagsResult {
  migrated: number;
  childrenMoved: number;
  albumsTouched: number;
  inspirationsReindexed: number;
}

/**
 * 合并标签（文档 11.2）：source 并入 target，写操作全程单事务。
 * 同步面不止灵感绑定关系：
 *  1) inspiration_tag 迁移去重，usage_count 按实际绑定重算（并发安全靠主键 + ON CONFLICT）；
 *  2) 画册规则 album.rules.requireTags 里的 sourceId → targetId，规则组合并去重；
 *  3) album_gap.requirement 里的 tagIds 同步迁移、重复缺口合并，随后重算缺口状态；
 *  4) source 的子标签改挂到 source 的父标签（挂到 target 下在 target 是 source 后代时会成环）；
 *  5) 受影响历史灵感的全文索引（FTS tags 列冗余了标签名）重建。
 * 已发布的 album_snapshot 是不可变快照，刻意不回写。
 */
export function mergeTags(sourceId: string, targetId: string, libraryId: string): MergeTagsResult {
  const db = getDb();
  const src = db.prepare('SELECT * FROM tag WHERE id = ?').get(sourceId) as
    | { id: string; library_id: string; domain: string; parent_id: string | null }
    | undefined;
  const tgt = db.prepare('SELECT * FROM tag WHERE id = ?').get(targetId) as
    | { id: string; library_id: string; domain: string }
    | undefined;
  if (!src || !tgt) throw errors.notFound('标签');
  if (src.library_id !== libraryId || tgt.library_id !== libraryId) throw errors.scopeDenied();
  if (src.domain !== tgt.domain) throw errors.badRequest('只能合并同一标签域内的标签');
  if (sourceId === targetId) throw errors.badRequest('源标签与目标标签不能相同');

  const result: MergeTagsResult = {
    migrated: 0,
    childrenMoved: 0,
    albumsTouched: 0,
    inspirationsReindexed: 0,
  };
  let touchedAlbumIds: string[] = [];

  const run = db.transaction(() => {
    // 1) 历史灵感绑定关系迁移（ON CONFLICT 去重，不产生重复关系）
    const bindings = db
      .prepare('SELECT DISTINCT inspiration_id FROM inspiration_tag WHERE tag_id = ?')
      .all(sourceId) as { inspiration_id: string }[];
    const insertBinding = db.prepare(
      `INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?, 'bulk', ?)
       ON CONFLICT (inspiration_id, tag_id) DO NOTHING`,
    );
    const ts = nowIso();
    for (const b of bindings) insertBinding.run(b.inspiration_id, targetId, ts);
    result.migrated = bindings.length;

    // 2) 画册规则里的 tagId 迁移
    const albums = db
      .prepare('SELECT id, rules FROM album WHERE library_id = ? AND deleted_at IS NULL')
      .all(libraryId) as { id: string; rules: string }[];
    touchedAlbumIds = [];
    for (const album of albums) {
      const next = migrateRules(normalizeRules(album.rules), sourceId, targetId);
      if (next) {
        db.prepare('UPDATE album SET rules = ?, updated_at = ? WHERE id = ?').run(toJson(next), ts, album.id);
        touchedAlbumIds.push(album.id);
      }
    }
    result.albumsTouched = touchedAlbumIds.length;

    // 3) 画册缺口 requirement 里的 tagIds 同步 + 归一后重复缺口合并（保留最早一条）
    if (touchedAlbumIds.length) {
      const ph = touchedAlbumIds.map(() => '?').join(',');
      const tagGaps = db
        .prepare(
          `SELECT id, album_id, requirement FROM album_gap
           WHERE kind = 'tag' AND album_id IN (${ph}) AND requirement LIKE ?`,
        )
        .all(...touchedAlbumIds, `%"${sourceId}"%`) as {
        id: string;
        album_id: string;
        requirement: string;
      }[];
      for (const gap of tagGaps) {
        const req = parseJson<{ tagIds?: string[] }>(gap.requirement, {});
        if (!Array.isArray(req.tagIds) || !req.tagIds.includes(sourceId)) continue;
        const nextTagIds = [...new Set(req.tagIds.map((t) => (t === sourceId ? targetId : t)))];
        db.prepare('UPDATE album_gap SET requirement = ?, updated_at = ? WHERE id = ?').run(
          toJson({ ...req, tagIds: nextTagIds }),
          ts,
          gap.id,
        );
      }
      const dupes = db
        .prepare(
          `SELECT album_id, requirement, MIN(id) AS keep_id, COUNT(*) AS c
           FROM album_gap WHERE kind = 'tag' AND album_id IN (${ph})
           GROUP BY album_id, requirement HAVING c > 1`,
        )
        .all(...touchedAlbumIds) as { album_id: string; requirement: string; keep_id: string }[];
      for (const d of dupes) {
        db.prepare('DELETE FROM album_gap WHERE album_id = ? AND requirement = ? AND id <> ?').run(
          d.album_id,
          d.requirement,
          d.keep_id,
        );
      }
    }

    // 4) 子标签改挂到 source 的父标签；source 是顶层时置空。
    //    不挂到 target 下：target 若是 source 的后代，直接挂 target 会立刻成环。
    result.childrenMoved = (
      db.prepare('SELECT COUNT(*) AS n FROM tag WHERE parent_id = ?').get(sourceId) as { n: number }
    ).n;
    db.prepare('UPDATE tag SET parent_id = ?, updated_at = ? WHERE parent_id = ?').run(
      src.parent_id,
      ts,
      sourceId,
    );

    // 5) 删除源标签（inspiration_tag 随 FK CASCADE 清理），按实际绑定重算 target.usage_count
    db.prepare('DELETE FROM tag WHERE id = ?').run(sourceId);
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM inspiration_tag WHERE tag_id = ?').get(targetId) as { n: number }
    ).n;
    db.prepare('UPDATE tag SET usage_count = ?, updated_at = ? WHERE id = ?').run(n, ts, targetId);
  });
  run();

  // 事务外：重建受影响历史灵感的 FTS（标签名冗余列），重算受影响画册的缺口
  const affectedInspirations = (
    db
      .prepare('SELECT DISTINCT inspiration_id FROM inspiration_tag WHERE tag_id = ?')
      .all(targetId) as { inspiration_id: string }[]
  ).map((r) => r.inspiration_id);
  for (const inspirationId of affectedInspirations) reindexFts(inspirationId);
  result.inspirationsReindexed = affectedInspirations.length;
  for (const albumId of touchedAlbumIds) regenerateGaps(albumId, libraryId);

  return result;
}

/**
 * 把规则中的 sourceId 替换为 targetId。
 * 同一 requireTags 组内 tagIds 去重；替换后出现两个等价组时合并：
 * min 取较大值（两个门槛都要满足），required 取或（任一要求必需则必需）。
 * 返回 null 表示规则未变化。
 */
function migrateRules(
  rules: AlbumRulesShape,
  sourceId: string,
  targetId: string,
): AlbumRulesShape | null {
  let changed = false;
  const groups = rules.requireTags.map((g) => {
    if (!g.tagIds.includes(sourceId)) return g;
    changed = true;
    return { ...g, tagIds: [...new Set(g.tagIds.map((t) => (t === sourceId ? targetId : t)))] };
  });

  const merged: AlbumRulesShape['requireTags'] = [];
  for (const g of groups) {
    const key = JSON.stringify([...g.tagIds].sort());
    const prior = merged.find((m) => JSON.stringify([...m.tagIds].sort()) === key);
    if (prior) {
      prior.min = Math.max(prior.min, g.min);
      prior.required = prior.required || g.required;
    } else {
      merged.push({ ...g });
    }
  }

  return changed ? { ...rules, requireTags: merged } : null;
}

export function listTags(libraryId: string, includeDisabled = false): Record<string, unknown>[] {
  const where = includeDisabled ? '' : 'AND disabled = 0';
  return getDb()
    .prepare(`SELECT * FROM tag WHERE library_id = ? ${where} ORDER BY domain, sort_order, name`)
    .all(libraryId) as Record<string, unknown>[];
}

/** 标签补全建议：基于同库共现频次（只建议、不自动写入，文档 11.2） */
export function suggestTags(
  libraryId: string,
  tagIds: string[],
  limit = 8,
): { id: string; name: string; domain: string; score: number }[] {
  const db = getDb();
  if (!tagIds.length) {
    return (
      db
        .prepare(
          'SELECT id, name, domain, usage_count FROM tag WHERE library_id = ? AND disabled = 0 ORDER BY usage_count DESC LIMIT ?',
        )
        .all(libraryId, limit) as { id: string; name: string; domain: string; usage_count: number }[]
    ).map((t) => ({ id: t.id, name: t.name, domain: t.domain, score: t.usage_count }));
  }

  const placeholders = tagIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.domain, COUNT(*) AS co
       FROM inspiration_tag a
       JOIN inspiration_tag b ON a.inspiration_id = b.inspiration_id
       JOIN tag t ON t.id = b.tag_id
       WHERE a.tag_id IN (${placeholders})
         AND b.tag_id NOT IN (${placeholders})
         AND t.library_id = ? AND t.disabled = 0
       GROUP BY t.id
       ORDER BY co DESC
       LIMIT ?`,
    )
    .all(...tagIds, ...tagIds, libraryId, limit) as {
    id: string;
    name: string;
    domain: string;
    co: number;
  }[];
  return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain, score: r.co }));
}
