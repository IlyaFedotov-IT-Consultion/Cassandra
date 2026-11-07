import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  fetchProviderJson,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";

interface PolymarketClobPayload {
  prices: ProviderDocument[];
}

interface ClobMarketResponse {
  condition_id: string;
  question?: string;
  tokens: Array<{ token_id: string; outcome: string; price?: number | string }>;
}

function toProbability(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : null;
}

export function createPolymarketClobProvider(config: { baseUrl?: string } = {}): EvidenceProvider {
  return {
    name: "polymarketClob",
    async collect(input): Promise<EvidenceItem[]> {
      const baseUrl = config.baseUrl ?? "https://clob.polymarket.com";

      if (input.mode === "fixture") {
        const payload = await loadProviderFixture<PolymarketClobPayload>("polymarketClob", input.event.question);
        return payload.prices.map((document) =>
          createProviderEvidenceItem({
            eventId: input.event.id,
            sourceFamily: "prediction_market",
            sourceType: "quote_snapshot",
            document,
            metadata: { provider: "polymarketClob" },
          }),
        );
      }

      // CLOB markets are keyed by condition id (0x...). Slugs and numeric Gamma ids
      // belong to the Gamma provider, so skip them instead of issuing a doomed request.
      const conditionId = input.event.polymarketMarketId;
      if (!conditionId || !/^0x[0-9a-f]+$/i.test(conditionId)) {
        return [];
      }

      let market: ClobMarketResponse;
      try {
        market = await fetchProviderJson<ClobMarketResponse>(
          `${baseUrl}/markets/${encodeURIComponent(conditionId)}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("404")) {
          return [];
        }
        throw new Error(`polymarketClob failed for condition_id "${conditionId}": ${message}`);
      }

      const yesToken = (market.tokens ?? []).find(
        (token) => String(token.outcome ?? "").trim().toLowerCase() === "yes" && token.token_id,
      );
      if (!yesToken) {
        return [];
      }

      let probability = toProbability(yesToken.price);
      try {
        const midpoint = await fetchProviderJson<{ mid?: string | number }>(
          `${baseUrl}/midpoint?token_id=${encodeURIComponent(yesToken.token_id)}`,
        );
        probability = toProbability(midpoint.mid) ?? probability;
      } catch {
        // Fall back to the token price embedded in the market payload.
      }

      if (probability === null) {
        return [];
      }

      const prices: ProviderDocument[] = [
        {
          title: market.question ?? input.event.question,
          url: `https://polymarket.com/market/${conditionId}`,
          publisher: "Polymarket CLOB",
          publishedAt: new Date().toISOString(),
          summary: `Yes midpoint price: ${probability}`,
          metadata: {
            provider: "polymarketClob",
            probability,
            tokenId: yesToken.token_id,
            outcome: "Yes",
            conditionId,
          },
          qualitySignals: {},
        },
      ];

      return prices.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "prediction_market",
          sourceType: "quote_snapshot",
          document,
          metadata: { provider: "polymarketClob" },
        }),
      );
    },
  };
}
