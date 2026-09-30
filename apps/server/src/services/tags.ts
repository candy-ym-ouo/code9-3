import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import { reindexFts, slugify } from './inspirations.js';
import { regenerateGaps, type AlbumRulesShape } from './albums.js';

interface TagRow {
  id: string;
  library_id: string;
  domain: string;
  parent_id: string | null;
  name: string;
  slug: string;
  is_builtin: number;
}

function loadTag(id: string): TagRow | undefined {
  return getDb().prepare('SELECT * FROM tag WHERE id = ?').get(id) as TagRow | undefined;
}

/** 同库同域名校验（slug 是唯一键 (library_id, domain, slug) 的业务投影） */
function assertNameAvailable(libraryId: string, domain: string, name: string, exceptId?: string): void {
  const slug = slugify(name);
  const existing = getDb()
    .prepare('SELECT id FROM tag WHERE library_id = ? AND domain = ? AND slug = ?')
    .get(libraryId, domain, slug) as { id: string } | undefined;
  if (existing && existing.id !== exceptId) {
    throw errors.badRequest('同域下已存在同名标签', { tagId: existing.id });
  }
}

function assertParent(parentId: string | null | undefined, libraryId: string, domain: string): void {
  if (!parentId) return;
  const parent = loadTag(parentId);
  if (!parent) throw errors.notFound('父标签');
  if (parent.library_id !== libraryId) throw errors.scopeDenied();
  if (parent.domain !== domain) throw errors.badRequest('父标签必须属于同一标签域');
}

/**
 * 循环父子关系检测（文档 11.2）：
 * 把 tagId 挂到 newParentId 下时，newParentId 不允许是 tagId 自己或其任意子孙。
 * parentId 为 null（提到根级）永远合法。
 */
function assertNoCycle(tagId: string, newParentId: string | null, libraryId: string, domain: string): void {
  if (newParentId === null) return;
  if (newParentId === tagId) throw errors.tagCycle();
  assertParent(newParentId, libraryId, domain);

  // 沿 newParentId 的祖先链向上走，遇到 tagId 即说明 newParentId 是其子孙
  let cursor: string | null = newParentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === tagId) throw errors.tagCycle();
    if (seen.has(cursor)) throw errors.tagCycle(); // 数据里已有环，拒绝继续制造
    seen.add(cursor);
    const row = loadTag(cursor);
    cursor = row?.parent_id ?? null;
  }
}

export function createTag(params: {
  libraryId: string;
  domain: string;
  name: string;
  parentId?: string | null;
}): string {
  const db = getDb();
  const slug = slugify(params.name);
  assertNameAvailable(params.libraryId, params.domain, params.name);
  assertParent(params.parentId ?? null, params.libraryId, params.domain);

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
  ).run(
    id,
    params.libraryId,
    params.domain,
    params.parentId ?? null,
    params.name,
    slug,
    maxOrder + 10,
    ts,
    ts,
  );
  return id;
}

export function updateTag(
  id: string,
  libraryId: string,
  patch: { name?: string; parentId?: string | null; sortOrder?: number; disabled?: boolean },
): void {
  const db = getDb();
  const row = loadTag(id);
  if (!row) throw errors.notFound('标签');
  if (row.library_id !== libraryId) throw errors.scopeDenied();

  if (patch.name !== undefined) {
    if (row.is_builtin) throw errors.forbiddenRole('内置标签不可改名，可停用或新增自定义标签');
    assertNameAvailable(libraryId, row.domain, patch.name, id);
    const ts = nowIso();
    db.prepare('UPDATE tag SET name = ?, slug = ?, updated_at = ? WHERE id = ?').run(
      patch.name,
      slugify(patch.name),
      ts,
      id,
    );
    // 改名不换 id，但历史灵感的 FTS 索引与画册快照文本里存的是名称 —— 必须同步重建索引，
    // 否则按新名检索不到旧卡（文档 11.2 / 15.1）。已发布快照是不可变历史，不回改。
    syncInspirationSearch(id);
  }
  if (patch.parentId !== undefined) {
    assertNoCycle(id, patch.parentId, libraryId, row.domain);
    db.prepare('UPDATE tag SET parent_id = ?, updated_at = ? WHERE id = ?').run(
      patch.parentId,
      nowIso(),
      id,
    );
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
}

/** 重算受某标签影响的全部历史灵感的检索索引（在事务内调用） */
function syncInspirationSearch(tagId: string): void {
  const ids = (
    getDb()
      .prepare('SELECT inspiration_id FROM inspiration_tag WHERE tag_id = ?')
      .all(tagId) as { inspiration_id: string }[]
  ).map((r) => r.inspiration_id);
  for (const inspirationId of ids) reindexFts(inspirationId);
}

/**
 * 把所有画册规则里的源标签引用替换为目标标签，组内去重并丢弃空组；
 * 规则变化的画册重算缺口。返回受影响（需重算缺口）的画册 id。
 */
function syncAlbumRulesOnMerge(sourceId: string, targetId: string, libraryId: string): string[] {
  const db = getDb();
  const albums = db
    .prepare('SELECT id, rules FROM album WHERE library_id = ? AND deleted_at IS NULL')
    .all(libraryId) as { id: string; rules: string }[];

  const touched: string[] = [];
  for (const album of albums) {
    const rules = parseJson<Partial<AlbumRulesShape>>(album.rules, {});
    if (!Array.isArray(rules.requireTags) || !rules.requireTags.length) continue;
    if (!rules.requireTags.some((r) => r.tagIds.includes(sourceId))) continue;

    const nextGroups: AlbumRulesShape['requireTags'] = [];
    for (const group of rules.requireTags) {
      const replaced = group.tagIds.map((t) => (t === sourceId ? targetId : t));
      const unique = [...new Set(replaced)];
      if (unique.length) nextGroups.push({ ...group, tagIds: unique });
    }
    const mergedRules: AlbumRulesShape = {
      requireTags: nextGroups,
      requireAnchors: rules.requireAnchors ?? [],
      requireWeather: rules.requireWeather ?? [],
      requireResultShots: rules.requireResultShots,
      totalMin: rules.totalMin ?? 6,
      autoMatch: rules.autoMatch ?? { enabled: true, minTagHits: 2 },
    };
    db.prepare('UPDATE album SET rules = ?, updated_at = ? WHERE id = ?').run(
      toJson(mergedRules),
      nowIso(),
      album.id,
    );
    touched.push(album.id);
  }
  return touched;
}

/**
 * 合并标签（文档 11.2）：
 * 1) 绑定关系迁移到目标标签并按主键去重；
 * 2) 源标签的子标签改挂（含"祖先并入子孙"时的防环处理）；
 * 3) usage_count 按真实绑定数重算；
 * 4) 历史灵感 FTS 索引、画册规则中的标签引用同步；
 * 5) 受影响画册重算缺口。已发布快照是不可变历史，不回改。
 */
export function mergeTags(sourceId: string, targetId: string, libraryId: string): void {
  const db = getDb();
  const src = loadTag(sourceId);
  const tgt = loadTag(targetId);
  if (!src || !tgt) throw errors.notFound('标签');
  if (src.library_id !== libraryId || tgt.library_id !== libraryId) throw errors.scopeDenied();
  if (src.domain !== tgt.domain) throw errors.badRequest('只能合并同一标签域内的标签');
  if (sourceId === targetId) throw errors.badRequest('源标签与目标标签不能相同');

  // 受影响的历史灵感（合并前后都要重建：删掉源标签后、挂上目标标签后名称集合都变了）
  const affectedInspirations = (
    db
      .prepare('SELECT DISTINCT inspiration_id FROM inspiration_tag WHERE tag_id IN (?, ?)')
      .all(sourceId, targetId) as { inspiration_id: string }[]
  ).map((r) => r.inspiration_id);

  const run = db.transaction(() => {
    const bindings = db
      .prepare('SELECT inspiration_id FROM inspiration_tag WHERE tag_id = ?')
      .all(sourceId) as { inspiration_id: string }[];
    const insertBinding = db.prepare(
      `INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?, 'bulk', ?)
       ON CONFLICT (inspiration_id, tag_id) DO NOTHING`,
    );
    for (const b of bindings) insertBinding.run(b.inspiration_id, targetId, nowIso());

    // 子标签改挂：默认全部挂到目标标签。
    // 特例——目标本身是源的子孙时，目标祖先链上"源的那个直接子节点"不能跟着挂到目标
    // （那样目标又成了自己子孙的后代，形成环）；把它提到源的原父级。
    let onPathId: string | null = null;
    let cursor: string | null = targetId;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      const node = loadTag(cursor);
      if (!node || node.parent_id === null) break;
      if (node.parent_id === sourceId) {
        onPathId = cursor;
        break;
      }
      cursor = node.parent_id;
    }
    db.prepare('UPDATE tag SET parent_id = ?, updated_at = ? WHERE parent_id = ? AND id IS NOT ?').run(
      tgt.id,
      nowIso(),
      sourceId,
      onPathId,
    );
    if (onPathId) {
      db.prepare('UPDATE tag SET parent_id = ?, updated_at = ? WHERE id = ?').run(
        src.parent_id,
        nowIso(),
        onPathId,
      );
    }

    const touchedAlbums = syncAlbumRulesOnMerge(sourceId, targetId, libraryId);

    db.prepare('DELETE FROM tag WHERE id = ?').run(sourceId);
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM inspiration_tag WHERE tag_id = ?').get(targetId) as { n: number }
    ).n;
    db.prepare('UPDATE tag SET usage_count = ? WHERE id = ?').run(n, targetId);

    for (const inspirationId of affectedInspirations) reindexFts(inspirationId);

    // 缺口重算放在同一事务内：规则 JSON 与 gap 行不会出现中间可见的不一致
    for (const albumId of touchedAlbums) regenerateGaps(albumId, libraryId);
  });
  run();
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
