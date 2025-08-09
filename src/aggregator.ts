export class AggregatorDO {
  state: DurableObjectState;
  storage: DurableObjectStorage;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ingest" && req.method === "POST") {
      const sample = await req.json() as any;
      // sample: { ip, bytes, durationMs, ts?, asn, country, city }
      const now = Date.now();
      const ts = sample.ts || now;
      const throughputMbps = (sample.bytes * 8) / (sample.durationMs / 1000) / 1_000_000;

      const key = `ip:${sample.ip}`;
      const prev = (await this.storage.get<{
        ewma: number; n: number; last: number;
      }>(key)) || { ewma: 0, n: 0, last: 0 };

      const alpha = 0.3;
      const ewma = prev.n === 0 ? throughputMbps : alpha * throughputMbps + (1 - alpha) * prev.ewma;

      await this.storage.put(key, { ewma, n: prev.n + 1, last: ts });

      // 也可按 ASN 维度存一个索引集合（示例简化略）
      return new Response(JSON.stringify({ ok: true, ip: sample.ip, ewma }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/computeTop") {
      // 简化：扫描所有键，计算 score 并返回前100
      const now = Date.now();
      const list: { ip: string; score: number; ewma: number; last: number }[] = [];
      const iter = this.storage.list<{
        ewma: number; n: number; last: number;
      }>({ prefix: "ip:" });

      for await (const [k, v] of iter) {
        const ip = k.slice(3);
        const age = (now - v.last) / 1000;
        const freshness = Math.exp(-age / 180); // 3分钟时间常数
        const score = v.ewma * freshness * (v.n >= 5 ? 1 : 0.6);
        list.push({ ip, score, ewma: v.ewma, last: v.last });
      }
      list.sort((a, b) => b.score - a.score);
      const top = list.slice(0, 100);

      return new Response(JSON.stringify(top), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }
}
