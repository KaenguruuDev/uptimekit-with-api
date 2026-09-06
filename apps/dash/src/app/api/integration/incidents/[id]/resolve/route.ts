import { resolveIncident } from "@uptimekit/api/pkg/incidents/service";
import { NextResponse } from "next/server";
import { authorizeIntegrationRequest } from "@/lib/integration-auth";

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = authorizeIntegrationRequest(request);
    if (!auth.ok) return auth.response;
    try {
        const result = await resolveIncident(
            auth.organizationId,
            (await params).id,
            { name: "integration" },
        );
        return NextResponse.json(result);
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Incident not found",
            },
            { status: 404 },
        );
    }
}
