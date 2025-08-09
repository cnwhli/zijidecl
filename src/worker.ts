export interface Env {
  FAST_TOP_KV: KVNamespace;
  AGGREGATOR: DurableObjectNamespace;
  DEFAULT_BYTES: string; // default size for /dl
}

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
    ...init,
  });
}

function parseClientCtx(req: Request) {
  // Cloudflare 注入
  // @ts-ignore
  const cf = req.cf || {};
  const ip = req.headers.get("CF-Connecting-IP") || "";
  return {
    ip,
    asn: cf.asn ? String(cf.asn) : "AS-UNKNOWN",
    country: cf.country || "XX",
    city: cf.city || "NA",
    colo: cf.colo || "NA",
  };
}

async function streamBytes(bytes: number): Promise<Response> {
  const chunk = new Uint8Array(64 * 1024);
  crypto.getRandomValues(chunk); // 避免压缩优化
  const total = bytes;
  const stream = new ReadableStream({
    start(controller) {
      let sent = 0;
      const push = () => {
        if (sent >= total) {
          controller.close();
          return;
        }
        const n = Math.min(chunk.length, total - sent);
        controller.enqueue(chunk.subarray(0, n));
        sent += n;
        setTimeout(push, 0);
      };
      push();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") {
      return new Response("cf-ip-optimizer: ok", { status: 200 });
    }

    // 生成下载流：用于 Runner 测速
    if (path === "/dl") {
      const n = Number(url.searchParams.get("bytes") || env.DEFAULT_BYTES || "5000000");
      const bounded = Math.max(1024, Math.min(n, 50_000_000)); // 1KB ~ 50MB
      return streamBytes(bounded);
    }

    // 返回当前访客的 TOP100（按 ASN）
    if (path === "/api/rank") {
      const { asn } = parseClientCtx(req);
      const key = `top:${asn}`;
      const cached = await env.FAST_TOP_KV.get(key, "json");
      if (cached) return jsonResponse({ asn, top: cached });

      // miss: 从 DO 现算一次并写回
      const id = env.AGGREGATOR.idFromName(asn);
      const stub = env.AGGREGATOR.get(id);
      const top = await stub.fetch("https://do/computeTop").then((r) => r.json());
      ctx.waitUntil(env.FAST_TOP_KV.put(key, JSON.stringify(top), { expirationTtl: 90 }));
      return jsonResponse({ asn, top });
    }

    // Runner 上报测速样本
    if (path === "/api/report" && req.method === "POST") {
      const body = await req.json();
      const { asn, country, city } = parseClientCtx(req); // 以服务端为准，也可允许客户端覆盖
      const id = env.AGGREGATOR.idFromName(asn);
      const stub = env.AGGREGATOR.get(id);
      const res = await stub.fetch("https://do/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, asn, country, city }),
      });
      return jsonResponse(await res.json());
    }

    // 候选 IP 下发（可把静态清单放在 KV 或内置）
    if (path === "/api/candidates") {
      // 你可以将这份列表托管在 KV：CANDIDATES_JSON
      const inline = [
        // 可放 Cloudflare Anycast 候选 IP（v4/v6 混合）
        "104.16.0.0", "104.17.0.0", "172.64.0.0", "188.114.96.0",
        // ...放你自定义的精简候选池（建议200–500个）
      ];
      return jsonResponse({ candidates: inline });
    }

    // Cron：周期刷新各热门 ASN 的 TOP100
    if (path === "/cron/refresh") {
      const hotAsns = ["4134", "4837", "9808", "4538", "AS-UNKNOWN"]; // 示例
      await Promise.all(
        hotAsns.map(async (asn) => {
          const id = env.AGGREGATOR.idFromName(asn);
          const stub = env.AGGREGATOR.get(id);
          const top = await stub.fetch("https://do/computeTop").then((r) => r.json());
          await env.FAST_TOP_KV.put(`top:${asn}`, JSON.stringify(top), { expirationTtl: 120 });
        })
      );
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  // Cron 触发
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const req = new Request("https://worker/cron/refresh");
    ctx.waitUntil(this.fetch!(req, env, ctx));
  },
};
