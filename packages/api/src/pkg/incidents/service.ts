import { ORPCError } from "@orpc/server";
import { db } from "@uptimekit/db";
import {
    incident,
    incidentActivity,
    incidentMonitor,
    incidentStatusPage,
} from "@uptimekit/db/schema/incidents";
import { monitor } from "@uptimekit/db/schema/monitors";
import { statusPage } from "@uptimekit/db/schema/status-pages";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { publishAppEvent } from "../../lib/events";
import { processPendingNotifications } from "../notifications";

export const incidentTimestampSchema = z.coerce.date();
export const incidentStatusSchema = z.enum([
    "investigating",
    "identified",
    "monitoring",
    "resolved",
]);
export const incidentSeveritySchema = z.enum([
    "minor",
    "major",
    "critical",
    "maintenance",
]);

export const incidentCreateInputSchema = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    severity: incidentSeveritySchema,
    monitorIds: z.array(z.string()).default([]),
    statusPageIds: z.array(z.string()).default([]),
    startedAt: incidentTimestampSchema.optional(),
    plannedEndAt: incidentTimestampSchema.nullable().optional(),
    endedAt: incidentTimestampSchema.nullable().optional(),
});

export const incidentUpdateInputSchema = z.object({
    id: z.string(),
    title: z.string().min(1),
    description: z.string().optional(),
    severity: incidentSeveritySchema,
    startedAt: incidentTimestampSchema,
    plannedEndAt: incidentTimestampSchema.nullable().optional(),
    endedAt: incidentTimestampSchema.nullable().optional(),
    monitorIds: z.array(z.string()).default([]),
    statusPageIds: z.array(z.string()).default([]),
});

export type IncidentActor = { userId?: string | null; name: string };

function ensureValidTimeline(
    startedAt: Date,
    endedAt: Date | null,
    plannedEndAt: Date | null,
) {
    if (endedAt && endedAt < startedAt) {
        throw new ORPCError("BAD_REQUEST", {
            message: "Incident end time cannot be before the start time",
        });
    }
    if (plannedEndAt && plannedEndAt < startedAt) {
        throw new ORPCError("BAD_REQUEST", {
            message: "Planned end time cannot be before the start time",
        });
    }
}

async function assertOrganizationResources(
    organizationId: string,
    monitorIds: string[],
    statusPageIds: string[],
) {
    const [matchingMonitors, matchingStatusPages] = await Promise.all([
        monitorIds.length
            ? db
                  .select({ id: monitor.id })
                  .from(monitor)
                  .where(
                      and(
                          eq(monitor.organizationId, organizationId),
                          inArray(monitor.id, monitorIds),
                      ),
                  )
            : Promise.resolve([]),
        statusPageIds.length
            ? db
                  .select({ id: statusPage.id })
                  .from(statusPage)
                  .where(
                      and(
                          eq(statusPage.organizationId, organizationId),
                          inArray(statusPage.id, statusPageIds),
                      ),
                  )
            : Promise.resolve([]),
    ]);
    if (matchingMonitors.length !== new Set(monitorIds).size) {
        throw new ORPCError("BAD_REQUEST", {
            message: "One or more monitors do not belong to the organization",
        });
    }
    if (matchingStatusPages.length !== new Set(statusPageIds).size) {
        throw new ORPCError("BAD_REQUEST", {
            message:
                "One or more status pages do not belong to the organization",
        });
    }
}

function activity(
    actor: IncidentActor,
    incidentId: string,
    message: string,
    type: "comment" | "event",
    createdAt: Date,
) {
    return {
        id: crypto.randomUUID(),
        incidentId,
        message,
        type,
        createdAt,
        userId: actor.userId ?? null,
    };
}

export async function listIncidents(organizationId: string) {
    return db.query.incident.findMany({
        where: eq(incident.organizationId, organizationId),
        orderBy: [desc(incident.startedAt)],
        with: {
            monitors: { with: { monitor: true } },
            statusPages: { with: { statusPage: true } },
            activities: { orderBy: [desc(incidentActivity.createdAt)] },
        },
    });
}

export async function getIncident(organizationId: string, id: string) {
    const item = await db.query.incident.findFirst({
        where: and(
            eq(incident.id, id),
            eq(incident.organizationId, organizationId),
        ),
        with: {
            monitors: { with: { monitor: true } },
            statusPages: { with: { statusPage: true } },
            activities: {
                orderBy: [desc(incidentActivity.createdAt)],
                with: { user: true },
            },
            organization: true,
            acknowledgedByUser: true,
        },
    });
    if (!item)
        throw new ORPCError("NOT_FOUND", { message: "Incident not found" });
    return item;
}

export async function createIncident(
    organizationId: string,
    input: z.infer<typeof incidentCreateInputSchema>,
    actor: IncidentActor,
) {
    const id = crypto.randomUUID();
    const now = new Date();
    const startedAt = input.startedAt ?? now;
    const endedAt = input.endedAt ?? null;
    ensureValidTimeline(startedAt, endedAt, input.plannedEndAt ?? null);
    await assertOrganizationResources(
        organizationId,
        input.monitorIds,
        input.statusPageIds,
    );
    await db.transaction(async (tx) => {
        await tx.insert(incident).values({
            id,
            organizationId,
            title: input.title,
            description: input.description,
            severity: input.severity,
            status: endedAt ? "resolved" : "investigating",
            type: "manual",
            startedAt,
            plannedEndAt: input.plannedEndAt ?? null,
            endedAt,
            createdAt: now,
            updatedAt: now,
            resolvedAt: endedAt,
        });
        if (input.monitorIds.length)
            await tx.insert(incidentMonitor).values(
                input.monitorIds.map((monitorId) => ({
                    incidentId: id,
                    monitorId,
                })),
            );
        if (input.statusPageIds.length)
            await tx.insert(incidentStatusPage).values(
                input.statusPageIds.map((statusPageId) => ({
                    incidentId: id,
                    statusPageId,
                })),
            );
        await tx
            .insert(incidentActivity)
            .values(
                activity(
                    actor,
                    id,
                    `Incident created by ${actor.name}`,
                    "comment",
                    now,
                ),
            );
        if (input.statusPageIds.length)
            await tx
                .insert(incidentActivity)
                .values(
                    activity(
                        actor,
                        id,
                        `Published to ${input.statusPageIds.length} status page${input.statusPageIds.length === 1 ? "" : "s"}`,
                        "event",
                        now,
                    ),
                );
        await publishAppEvent(
            "incident.created",
            {
                incidentId: id,
                organizationId,
                title: input.title,
                description: input.description,
                severity: input.severity,
            },
            { tx },
        );
    });
    await processPendingNotifications("incident-created");
    return { id };
}

export async function updateIncident(
    organizationId: string,
    input: z.infer<typeof incidentUpdateInputSchema>,
    actor: IncidentActor,
) {
    const existing = await db.query.incident.findFirst({
        where: and(
            eq(incident.id, input.id),
            eq(incident.organizationId, organizationId),
        ),
        with: { monitors: true, statusPages: true },
    });
    if (!existing)
        throw new ORPCError("NOT_FOUND", { message: "Incident not found" });
    const endedAt = input.endedAt ?? null;
    ensureValidTimeline(input.startedAt, endedAt, input.plannedEndAt ?? null);
    await assertOrganizationResources(
        organizationId,
        input.monitorIds,
        input.statusPageIds,
    );
    const previousMonitorIds = existing.monitors.map((item) => item.monitorId);
    const previousStatusPageIds = existing.statusPages.map(
        (item) => item.statusPageId,
    );
    const monitorsToAdd = input.monitorIds.filter(
        (id) => !previousMonitorIds.includes(id),
    );
    const monitorsToRemove = previousMonitorIds.filter(
        (id) => !input.monitorIds.includes(id),
    );
    const statusPagesToAdd = input.statusPageIds.filter(
        (id) => !previousStatusPageIds.includes(id),
    );
    const statusPagesToRemove = previousStatusPageIds.filter(
        (id) => !input.statusPageIds.includes(id),
    );
    const nextStatus = endedAt
        ? "resolved"
        : existing.status === "resolved"
          ? existing.acknowledgedAt
              ? "identified"
              : "investigating"
          : existing.status;
    const messages: string[] = [];
    if (existing.startedAt.getTime() !== input.startedAt.getTime())
        messages.push(
            `Incident start time changed from ${existing.startedAt.toISOString()} to ${input.startedAt.toISOString()}`,
        );
    if ((existing.endedAt?.getTime() ?? null) !== (endedAt?.getTime() ?? null))
        messages.push(
            `Incident end time changed from ${existing.endedAt?.toISOString() ?? "unset"} to ${endedAt?.toISOString() ?? "unset"}`,
        );
    if (statusPagesToAdd.length)
        messages.push(
            `Published to ${statusPagesToAdd.length} additional status page${statusPagesToAdd.length === 1 ? "" : "s"}`,
        );
    if (statusPagesToRemove.length)
        messages.push(
            `Removed from ${statusPagesToRemove.length} status page${statusPagesToRemove.length === 1 ? "" : "s"}`,
        );
    await db.transaction(async (tx) => {
        await tx
            .update(incident)
            .set({
                title: input.title,
                description: input.description,
                severity: input.severity,
                startedAt: input.startedAt,
                plannedEndAt: input.plannedEndAt ?? null,
                endedAt,
                status: nextStatus,
                resolvedAt: endedAt,
                updatedAt: new Date(),
            })
            .where(eq(incident.id, input.id));
        if (monitorsToRemove.length)
            await tx
                .delete(incidentMonitor)
                .where(
                    and(
                        eq(incidentMonitor.incidentId, input.id),
                        inArray(incidentMonitor.monitorId, monitorsToRemove),
                    ),
                );
        if (monitorsToAdd.length)
            await tx.insert(incidentMonitor).values(
                monitorsToAdd.map((monitorId) => ({
                    incidentId: input.id,
                    monitorId,
                })),
            );
        if (statusPagesToRemove.length)
            await tx
                .delete(incidentStatusPage)
                .where(
                    and(
                        eq(incidentStatusPage.incidentId, input.id),
                        inArray(
                            incidentStatusPage.statusPageId,
                            statusPagesToRemove,
                        ),
                    ),
                );
        if (statusPagesToAdd.length)
            await tx.insert(incidentStatusPage).values(
                statusPagesToAdd.map((statusPageId) => ({
                    incidentId: input.id,
                    statusPageId,
                })),
            );
        if (messages.length)
            await tx
                .insert(incidentActivity)
                .values(
                    messages.map((message) =>
                        activity(actor, input.id, message, "event", new Date()),
                    ),
                );
        await publishAppEvent(
            "incident.updated",
            {
                incidentId: input.id,
                organizationId,
                title: input.title,
                description: input.description,
                severity: input.severity,
            },
            { tx },
        );
    });
    await processPendingNotifications("incident-updated");
    return { success: true };
}

export async function resolveIncident(
    organizationId: string,
    id: string,
    actor: IncidentActor,
) {
    const existing = await db.query.incident.findFirst({
        where: and(
            eq(incident.id, id),
            eq(incident.organizationId, organizationId),
        ),
    });
    if (!existing)
        throw new ORPCError("NOT_FOUND", { message: "Incident not found" });
    if (existing.endedAt) return { success: true, message: "Already resolved" };
    const now = new Date();
    await db.transaction(async (tx) => {
        await tx
            .update(incident)
            .set({
                status: "resolved",
                endedAt: now,
                resolvedAt: now,
                updatedAt: now,
            })
            .where(eq(incident.id, id));
        await tx
            .insert(incidentActivity)
            .values(
                activity(
                    actor,
                    id,
                    `Incident resolved by ${actor.name}`,
                    "comment",
                    now,
                ),
            );
        await publishAppEvent(
            "incident.resolved",
            {
                incidentId: id,
                organizationId,
                title: existing.title,
                description: existing.description,
                severity: existing.severity as z.infer<
                    typeof incidentSeveritySchema
                >,
            },
            { tx },
        );
    });
    await processPendingNotifications("incident-resolved");
    return { success: true };
}
