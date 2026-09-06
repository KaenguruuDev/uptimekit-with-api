import {
    getIncident,
    incidentUpdateInputSchema,
    updateIncident,
} from "@uptimekit/api/pkg/incidents/service";
import { NextResponse } from "next/server";
import { authorizeIntegrationRequest } from "@/lib/integration-auth";

const actor = { name: "integration" };

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = authorizeIntegrationRequest(request);
    if (!auth.ok) return auth.response;
    try {
        return NextResponse.json(
            await getIncident(auth.organizationId, (await params).id),
        );
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

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = authorizeIntegrationRequest(request);
    if (!auth.ok) return auth.response;
    try {
        const id = (await params).id;
        const { organizationId: _organizationId, ...body } =
            (await request.json()) as Record<string, unknown>;
        const input = incidentUpdateInputSchema.parse({
            ...body,
            id,
        });
        return NextResponse.json(
            await updateIncident(auth.organizationId, input, actor),
        );
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error ? error.message : "Invalid request",
            },
            { status: 400 },
        );
    }
}
