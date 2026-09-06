import {
    createIncident,
    incidentCreateInputSchema,
    listIncidents,
} from "@uptimekit/api/pkg/incidents/service";
import { NextResponse } from "next/server";
import { authorizeIntegrationRequest } from "@/lib/integration-auth";

const actor = { name: "integration" };

export async function GET(request: Request) {
    const auth = authorizeIntegrationRequest(request);
    if (!auth.ok) return auth.response;
    return NextResponse.json(await listIncidents(auth.organizationId));
}

export async function POST(request: Request) {
    const auth = authorizeIntegrationRequest(request);
    if (!auth.ok) return auth.response;
    try {
        const { organizationId: _organizationId, ...body } =
            (await request.json()) as Record<string, unknown>;
        const input = incidentCreateInputSchema.parse(body);
        return NextResponse.json(
            await createIncident(auth.organizationId, input, actor),
            { status: 201 },
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
