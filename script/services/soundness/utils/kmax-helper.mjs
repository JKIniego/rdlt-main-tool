import { findSiblings } from "../../well-handledness/src/Siblings.js";
import { utils } from "./rdlt-utils.mjs";
import { generateTotalContractionPath } from "./total-contraction-path.mjs";

export function determineKmax(graph, model) {
    let source = null;
    try {
        ({ source } = utils.getSourceAndSinkVertices(graph));
    } catch (error) {
        console.warn("Unable to determine source vertex for kmax check.", error);
        return 0;
    }

    const originalArcs = model?.arcs || [];
    const originalComponents = model?.components || [];

    if (!source || originalComponents.length === 0) {
        return 0;
    }

    const { P_Total } = generateTotalContractionPath({
        vertices: originalComponents,
        arcs: originalArcs,
        source
    });

    console.log("P_Total:", P_Total);

    const reachedVertices = new Set(P_Total.map(String));
    return originalArcs.filter(arc =>
        String(arc.fromVertexUID) === String(source.id) &&
        reachedVertices.has(String(arc.toVertexUID))
    ).length;
}

export function buildSplitJoinPairs(graph) {
    if (!graph || !graph.vertices || !graph.edges) {
        return {
            siblingPaths: new Map(),
            allDisjointPaths: []
        };
    }

    const getVertexId = vertex => vertex?.id ?? vertex?.name ?? vertex;

    const adjacency = new Map();

    for (const vertex of graph.vertices) {
        adjacency.set(vertex, new Map());
    }

    for (const edge of graph.edges) {
        const fromVertex = [...graph.vertices].find(v => getVertexId(v) === getVertexId(edge.from));
        const toVertex = [...graph.vertices].find(v => getVertexId(v) === getVertexId(edge.to));

        if (!fromVertex || !toVertex) continue;

        const neighbors = adjacency.get(fromVertex) ?? new Map();
        neighbors.set(toVertex, (neighbors.get(toVertex) ?? 0) + 1);
        adjacency.set(fromVertex, neighbors);
    }

    const splitPoints = [...graph.vertices].filter(vertex => {
        const outgoingArcs = graph.edges.filter(edge => getVertexId(edge.from) === getVertexId(vertex));
        return outgoingArcs.length > 1;
    });

    const joinPoints = [...graph.vertices].filter(vertex => {
        const incomingArcs = graph.edges.filter(edge => getVertexId(edge.to) === getVertexId(vertex));
        return incomingArcs.length > 1;
    });

    return findSiblings(adjacency, new Set(splitPoints), new Set(joinPoints));
}

export function getKmaxJoinTypes(graph) {
    const incomingEdges = new Map();
    for (const edge of graph.edges) {
        const vertexId = String(edge.to.id);
        const edges = incomingEdges.get(vertexId) ?? [];
        edges.push(edge);
        incomingEdges.set(vertexId, edges);
    }

    const joinTypes = new Map();
    const invalidJoinIds = [];
    for (const [vertexId, edges] of incomingEdges) {
        if (edges.length < 2) continue;

        const constraints = new Set(edges.map(edge => {
            const constraint = edge.constraint ?? "";
            return ["", "ϵ", "ε"].includes(constraint)
                ? ""
                : String(constraint);
        }));

        if (constraints.size === edges.length && !constraints.has("")) {
            joinTypes.set(vertexId, "AND");
        } else if (constraints.size === 1) {
            joinTypes.set(vertexId, "OR");
        } else if (constraints.size === 2) {
            joinTypes.set(vertexId, constraints.has("") ? "MIX" : "AND");
        } else {
            invalidJoinIds.push(vertexId);
        }
    }

    return { joinTypes, invalidJoinIds };
}