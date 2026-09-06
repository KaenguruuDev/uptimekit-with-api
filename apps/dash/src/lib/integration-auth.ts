import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

type AuthResult =
    | { ok: true; organizationId: string }
    | { ok: false; response: NextResponse };

export function authorizeIntegrationRequest(request: Request): AuthResult {
    const organizationId = process.env.INTEGRATION_ORGANIZATION_ID?.trim();
    const apiKey = process.env.INTEGRATION_API_KEY?.trim();
    if (!organizationId || !apiKey) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: "Integration API is not configured" },
                { status: 503 },
            ),
        };
    }
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${apiKey}`);
    if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
    ) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: "Invalid authorization token" },
                { status: 401 },
            ),
        };
    }
    return { ok: true, organizationId };
}
