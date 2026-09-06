import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

type AuthResult =
    | { ok: true; organizationId: string }
    | { ok: false; response: NextResponse };

type IntegrationKey = {
    key: string;
    organizationIds: string[];
};

function invalidConfiguration() {
    return NextResponse.json(
        { error: "Integration API is not configured" },
        { status: 503 },
    );
}

function getIntegrationKeys(): IntegrationKey[] | null {
    const configuredKeys = process.env.INTEGRATION_API_KEYS?.trim();
    if (configuredKeys) {
        try {
            const parsed: unknown = JSON.parse(configuredKeys);
            if (!Array.isArray(parsed) || parsed.length === 0) return null;

            const keys = parsed.map((entry): IntegrationKey | null => {
                if (!entry || typeof entry !== "object") return null;
                const { key, organizationIds } = entry as {
                    key?: unknown;
                    organizationIds?: unknown;
                };
                if (
                    typeof key !== "string" ||
                    !key.trim() ||
                    !Array.isArray(organizationIds) ||
                    organizationIds.length === 0 ||
                    organizationIds.some(
                        (organizationId) =>
                            typeof organizationId !== "string" ||
                            !organizationId.trim(),
                    )
                ) {
                    return null;
                }
                return {
                    key: key.trim(),
                    organizationIds: organizationIds.map((organizationId) =>
                        organizationId.trim(),
                    ),
                };
            });

            return keys.every(
                (entry): entry is IntegrationKey => entry !== null,
            )
                ? keys
                : null;
        } catch {
            return null;
        }
    }

    const key = process.env.INTEGRATION_API_KEY?.trim();
    const organizationId = process.env.INTEGRATION_ORGANIZATION_ID?.trim();
    return key && organizationId
        ? [{ key, organizationIds: [organizationId] }]
        : null;
}

function matchesSecret(actual: string, expected: string) {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return (
        actualBuffer.length === expectedBuffer.length &&
        timingSafeEqual(actualBuffer, expectedBuffer)
    );
}

export function authorizeIntegrationRequest(request: Request): AuthResult {
    const keys = getIntegrationKeys();
    if (!keys) {
        return { ok: false, response: invalidConfiguration() };
    }

    const authorization = request.headers.get("authorization") ?? "";
    const bearerKey = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
    const configuredKey = keys.find(({ key }) => matchesSecret(bearerKey, key));
    if (!configuredKey) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: "Invalid authorization token" },
                { status: 401 },
            ),
        };
    }

    const organizationHeader = request.headers.get("x-organization-id")?.trim();
    if (organizationHeader?.includes(",")) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: "Exactly one organization must be selected" },
                { status: 400 },
            ),
        };
    }

    if (configuredKey.organizationIds.length > 1 && !organizationHeader) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: "Organization selection is required" },
                { status: 400 },
            ),
        };
    }

    const organizationId =
        organizationHeader ?? configuredKey.organizationIds[0];
    if (!configuredKey.organizationIds.includes(organizationId)) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: "Organization is not authorized" },
                { status: 403 },
            ),
        };
    }

    return { ok: true, organizationId };
}
