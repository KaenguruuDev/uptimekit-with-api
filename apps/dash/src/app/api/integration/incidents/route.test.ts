import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createIncident: vi.fn(),
    getIncident: vi.fn(),
    listIncidents: vi.fn(),
    resolveIncident: vi.fn(),
    updateIncident: vi.fn(),
}));

vi.mock("@uptimekit/api/pkg/incidents/service", () => ({
    createIncident: mocks.createIncident,
    getIncident: mocks.getIncident,
    incidentCreateInputSchema: {
        parse: (input: unknown) => input,
    },
    incidentUpdateInputSchema: {
        parse: (input: unknown) => input,
    },
    listIncidents: mocks.listIncidents,
    resolveIncident: mocks.resolveIncident,
    updateIncident: mocks.updateIncident,
}));

import { POST as RESOLVE } from "./[id]/resolve/route";
import { GET as GET_ONE, PATCH } from "./[id]/route";
import { GET, POST } from "./route";

const headers = { authorization: "Bearer test-integration-key" };

describe("integration incident API", () => {
    beforeEach(() => {
        process.env.INTEGRATION_API_KEY = "test-integration-key";
        process.env.INTEGRATION_ORGANIZATION_ID = "org-configured";
        vi.clearAllMocks();
        mocks.listIncidents.mockResolvedValue([{ id: "incident-1" }]);
        mocks.createIncident.mockResolvedValue({ id: "incident-1" });
        mocks.getIncident.mockResolvedValue({ id: "incident-1" });
        mocks.updateIncident.mockResolvedValue({ success: true });
        mocks.resolveIncident.mockResolvedValue({ success: true });
    });

    it("rejects requests without the configured bearer key", async () => {
        const response = await GET(
            new Request("http://localhost/api/integration/incidents"),
        );
        expect(response.status).toBe(401);
    });

    it("fetches, creates, updates, and resolves without accepting an organization id", async () => {
        const listResponse = await GET(
            new Request("http://localhost/api/integration/incidents", {
                headers,
            }),
        );
        const createResponse = await POST(
            new Request("http://localhost/api/integration/incidents", {
                method: "POST",
                headers: {
                    ...headers,
                    "content-type": "application/json",
                    "x-organization-id": "attacker-org",
                },
                body: JSON.stringify({
                    title: "API down",
                    severity: "major",
                    monitorIds: ["monitor-1"],
                    statusPageIds: ["page-1"],
                }),
            }),
        );
        const params = Promise.resolve({ id: "incident-1" });
        const updateResponse = await PATCH(
            new Request(
                "http://localhost/api/integration/incidents/incident-1",
                {
                    method: "PATCH",
                    headers: { ...headers, "content-type": "application/json" },
                    body: JSON.stringify({
                        title: "API recovering",
                        severity: "major",
                        startedAt: "2026-01-01T00:00:00.000Z",
                        monitorIds: ["monitor-1"],
                        statusPageIds: ["page-1"],
                    }),
                },
            ),
            { params },
        );
        const resolveResponse = await RESOLVE(
            new Request(
                "http://localhost/api/integration/incidents/incident-1",
                { method: "POST", headers },
            ),
            { params },
        );
        const getResponse = await GET_ONE(
            new Request(
                "http://localhost/api/integration/incidents/incident-1",
                { headers },
            ),
            { params },
        );

        expect(listResponse.status).toBe(200);
        expect(createResponse.status).toBe(201);
        expect(updateResponse.status).toBe(200);
        expect(resolveResponse.status).toBe(200);
        expect(getResponse.status).toBe(200);
        expect(mocks.createIncident).toHaveBeenCalledWith(
            "org-configured",
            expect.objectContaining({
                monitorIds: ["monitor-1"],
                statusPageIds: ["page-1"],
            }),
            { name: "integration" },
        );
        expect(mocks.updateIncident).toHaveBeenCalledWith(
            "org-configured",
            expect.objectContaining({ id: "incident-1" }),
            { name: "integration" },
        );
        expect(mocks.resolveIncident).toHaveBeenCalledWith(
            "org-configured",
            "incident-1",
            { name: "integration" },
        );
    });
});
