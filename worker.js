// Cloudflare Worker برای «سامانه هوشمند عربی»
// نیازها:
//   ۱) یک KV Namespace با Binding به نام  ARB
//   ۲) یک Secret به نام  ADMIN_PASS  (رمز پنل معلم)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });

const EMPTY = () => ({ words: [], qa: [], verbs: [], exams: [] });
const curPass = async (env) => (await env.ARB.get('adminpass')) || env.ADMIN_PASS || '';
const isAdmin = async (env, p) => {
  const c = await curPass(env);
  return !!c && typeof p === 'string' && p === c;
};
async function getData(env) {
  const raw = await env.ARB.get('data');
  try {
    return raw ? { ...EMPTY(), ...JSON.parse(raw) } : EMPTY();
  } catch (e) {
    return EMPTY();
  }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const path = new URL(req.url).pathname;

    // ---- عمومی: داده برای دانش‌آموزان (جواب سوال‌های آزمون حذف می‌شود) ----
    if (req.method === 'GET' && path === '/data') {
      const d = await getData(env);
      d.exams = (d.exams || [])
        .filter((e) => e.on !== false)
        .map((e) => ({ id: e.id, title: e.title, min: e.min, qs: (e.qs || []).map((q) => ({ q: q.q, o: q.o })) }));
      return J(d);
    }

    if (req.method !== 'POST') return J({ ok: false, error: 'not found' }, 404);
    let b;
    try {
      b = await req.json();
    } catch (e) {
      return J({ ok: false, error: 'bad json' }, 400);
    }

    // ---- عمومی: ثبت و نمره‌دهی آزمون ----
    if (path === '/result') {
      const d = await getData(env);
      const ex = (d.exams || []).find((e) => e.id === b.e);
      if (!ex) return J({ ok: false, error: 'exam not found' }, 404);
      const name = String(b.n || '').trim().slice(0, 40);
      if (name.length < 2) return J({ ok: false, error: 'name' }, 400);
      const qs = ex.qs || [];
      const a = Array.isArray(b.a) ? b.a : [];
      if (a.length !== qs.length) return J({ ok: false, error: 'answers' }, 400);
      let score = 0;
      const key = qs.map((q) => q.c);
      qs.forEach((q, i) => {
        if (Number(a[i]) === q.c) score++;
      });
      const dur = Math.max(0, Math.min(Number(b.d) || 0, (Number(ex.min) || 1) * 60));
      const ts = Date.now();
      const k = `res:${ex.id}:${ts}:${Math.random().toString(36).slice(2, 7)}`;
      await env.ARB.put(
        k,
        JSON.stringify({ a: a.map((x) => (Number.isInteger(x) ? x : -1)) }),
        { metadata: { n: name, e: ex.id, s: score, t: qs.length, d: Math.round(dur), ts } }
      );
      return J({ ok: true, score, total: qs.length, key });
    }

    // ---- فقط معلم ----
    if (!(await isAdmin(env, b.pass))) return J({ ok: false, error: 'wrong password' }, 401);

    if (path === '/login') return J({ ok: true });
    if (path === '/adata') return J({ ok: true, data: await getData(env) });

    if (path === '/save') {
      const d = b.data;
      if (!d || !Array.isArray(d.words) || !Array.isArray(d.qa) || !Array.isArray(d.verbs) || !Array.isArray(d.exams))
        return J({ ok: false, error: 'bad data' }, 400);
      await env.ARB.put('data', JSON.stringify({ words: d.words, qa: d.qa, verbs: d.verbs, exams: d.exams }));
      return J({ ok: true });
    }

    if (path === '/pw') {
      if (typeof b.np !== 'string' || b.np.length < 4) return J({ ok: false, error: 'short password' }, 400);
      await env.ARB.put('adminpass', b.np);
      return J({ ok: true });
    }

    if (path === '/results') {
      const out = [];
      let cursor;
      do {
        const r = await env.ARB.list({ prefix: 'res:', cursor, limit: 1000 });
        r.keys.forEach((k) => k.metadata && out.push({ key: k.name, ...k.metadata }));
        cursor = r.list_complete ? undefined : r.cursor;
      } while (cursor);
      out.sort((x, y) => y.ts - x.ts);
      return J({ ok: true, results: out });
    }

    if (path === '/delres') {
      const keys = (Array.isArray(b.keys) ? b.keys : []).filter((k) => typeof k === 'string' && k.startsWith('res:'));
      for (const k of keys) await env.ARB.delete(k);
      return J({ ok: true });
    }

    return J({ ok: false, error: 'not found' }, 404);
  },
};
