import {
  divideDecimals,
  multiplyDecimals,
  parseDecimal,
  type DecimalInput,
} from "@open-mercato/shared/lib/decimal";
import { resolveMoneyDecimalPlaces, roundMoney } from "./lineItemUtils";

type ShippedLineSnapshot = {
  quantity: number;
  /** Prefer the exact decimal string of the stored total. */
  totalNetAmount?: DecimalInput | null;
  /** Prefer the exact decimal string of the stored total. */
  totalGrossAmount?: DecimalInput | null;
};

const SHIPPED_LINE_IMMUTABLE_PAYLOAD_FIELDS = [
  "kind",
  "productId",
  "productVariantId",
  "quantityUnit",
  "unitPriceNet",
  "unitPriceGross",
  "priceId",
  "priceMode",
  "taxRateId",
  "taxRate",
  "taxAmount",
  "discountAmount",
  "discountPercent",
  "catalogSnapshot",
  "metadata",
] as const;

function scaleTotal(
  total: DecimalInput | null | undefined,
  previousQuantity: number,
  nextQuantity: number,
): string | undefined {
  const exactTotal = parseDecimal(total);
  if (
    exactTotal === null ||
    !Number.isFinite(previousQuantity) ||
    previousQuantity <= 0
  ) {
    return undefined;
  }
  return roundMoney(
    divideDecimals(multiplyDecimals(exactTotal, nextQuantity), previousQuantity),
    resolveMoneyDecimalPlaces(exactTotal),
  );
}

export function prepareShippedLineUpdatePayload(
  payload: Record<string, unknown>,
  currentLine: ShippedLineSnapshot | null,
): Record<string, unknown> {
  if (!currentLine) return payload;

  const nextPayload = { ...payload };
  for (const field of SHIPPED_LINE_IMMUTABLE_PAYLOAD_FIELDS) {
    delete nextPayload[field];
  }

  delete nextPayload.totalNetAmount;
  delete nextPayload.totalGrossAmount;

  const nextQuantity = Number(nextPayload.quantity);
  if (!Number.isFinite(nextQuantity) || nextQuantity === currentLine.quantity) {
    return nextPayload;
  }

  const scaledNetTotal = scaleTotal(
    currentLine.totalNetAmount,
    currentLine.quantity,
    nextQuantity,
  );
  const scaledGrossTotal = scaleTotal(
    currentLine.totalGrossAmount,
    currentLine.quantity,
    nextQuantity,
  );
  if (scaledNetTotal !== undefined) nextPayload.totalNetAmount = scaledNetTotal;
  if (scaledGrossTotal !== undefined)
    nextPayload.totalGrossAmount = scaledGrossTotal;

  return nextPayload;
}
