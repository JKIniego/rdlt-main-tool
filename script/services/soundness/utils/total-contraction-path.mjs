const EPSILON = "ε";

function getVertexId(vertex) {
    return vertex?.uid ?? vertex?.vuid ?? vertex?.id ?? vertex;
}

function getArcEndpoints(arc) {
    return {
        from: getVertexId(arc.fromVertexUID ?? arc.from),
        to: getVertexId(arc.toVertexUID ?? arc.to)
    };
}

function getConstraint(arc) {
    const constraint = arc.c ?? arc.C ?? arc.constraint;
    return constraint === "E" || constraint === "epsilon" || constraint === ""
        ? EPSILON
        : (constraint ?? EPSILON);
}

/**
 * Build the matrices as 2D arrays aligned with the order of `vertices`:
 *   RV_adj[i][j] -> number of arcs from vertices[i] to vertices[j]
 *   RV_C[i][j]   -> array of distinct constraints on arcs vertices[i] -> vertices[j]
 */
function buildContractionMatrices(vertices, arcs) {
    const RV_adj = vertices.map(() => vertices.map(() => 0));
    const RV_C = vertices.map(() => vertices.map(() => []));

    for (const arc of arcs) {
        const endpoints = getArcEndpoints(arc);
        const from = vertices.findIndex(vertex => String(vertex) === String(endpoints.from));
        const to = vertices.findIndex(vertex => String(vertex) === String(endpoints.to));
        if (from === -1 || to === -1) continue;
        RV_adj[from][to] += 1;
        const constraint = getConstraint(arc);
        if (!RV_C[from][to].includes(constraint)) RV_C[from][to].push(constraint);
    }

    return { RV_adj, RV_C };
}

/**
 * Apply one matrix contraction, absorbing y into x.
 * `vertices` is an array; RV_adj and RV_C are 2D arrays aligned with it.
 * Returns new vertex array and matrices without mutating input. The
 * contracted vertex z is always the last element of the returned vertices.
 */
export function MatrixContractionUpdate(vertices, RV_adj, RV_C, x, y, U = []) {
    const xi = vertices.indexOf(x);
    const yi = vertices.indexOf(y);

    const keptIndices = [];
    for (let i = 0; i < vertices.length; i++) {
        if (i !== xi && i !== yi) keptIndices.push(i);
    }

    const z = Symbol("contracted-vertex");
    const nextVertices = [...keptIndices.map(i => vertices[i]), z];
    const size = nextVertices.length;
    const zi = size - 1;
    
    const oldIndices = nextVertices.map((_, k) => (k === zi ? [xi, yi] : [keptIndices[k]]));
    
    const constraints = RV_C.map(row => row.map(cell => [...cell]));
    for (const u of U) {
        const ui = vertices.indexOf(u);
        if (ui !== -1 && ui !== xi && ui !== yi) constraints[ui][yi] = [EPSILON];
    }

    const nextAdj = Array.from({ length: size }, () => Array(size).fill(0));
    const nextConstraints = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => [])
    );

    for (let from = 0; from < size; from++) {
        for (let to = 0; to < size; to++) {
            if (from === zi && to === zi) continue;

            for (const oldSource of oldIndices[from]) {
                for (const oldTarget of oldIndices[to]) {
                    nextAdj[from][to] += RV_adj[oldSource][oldTarget] ?? 0;
                    for (const constraint of constraints[oldSource][oldTarget] ?? []) {
                        if (!nextConstraints[from][to].includes(constraint)) {
                            nextConstraints[from][to].push(constraint);
                        }
                    }
                }
            }
        }
    }

    return { vertices: nextVertices, RV_adj: nextAdj, RV_C: nextConstraints, z };
}

/**
 * Generate the sequential total contraction path from a source vertex.
 *
 * Returns { P_Total }, where P_Total is an array of vertex IDs in the order
 * they were contracted.
 */
export function generateTotalContractionPath(graphInput) {
    const mappedVertices = (graphInput.vertices ?? []).map(getVertexId);
    const vertices = mappedVertices.filter((vertex, i) => mappedVertices.indexOf(vertex) === i);
    const sourceId = getVertexId(graphInput.source);
    const sourceIndex = vertices.findIndex(vertex => String(vertex) === String(sourceId));
    if (sourceIndex === -1) {
        throw new Error("The contraction-path source must be in vertices.");
    }

    const matrices = graphInput.RV_adj && graphInput.RV_C
        ? { RV_adj: graphInput.RV_adj, RV_C: graphInput.RV_C }
        : buildContractionMatrices(vertices, graphInput.arcs ?? []);
    let activeVertices = vertices;
    let { RV_adj, RV_C } = matrices;
    let x = sourceIndex;
    const P_Total = [vertices[sourceIndex]];
    let infeasibleCandidates = [];

    while (activeVertices.some((_, j) => j !== x && RV_adj[x][j] >= 1)) {
        let y = -1;
        for (let j = 0; j < activeVertices.length; j++) {
            if (j === x || RV_adj[x][j] < 1 || infeasibleCandidates.includes(j)) continue;
            y = j;
            break;
        }
        if (y === -1) {
            break;
        }

        const lhs = [...RV_C[x][y]];
        if (!lhs.includes(EPSILON)) lhs.push(EPSILON);

        const rhs = [];
        for (let u = 0; u < activeVertices.length; u++) {
            if (u === x || RV_adj[u][y] < 1) continue;
            for (const constraint of RV_C[u][y]) {
                if (!rhs.includes(constraint)) rhs.push(constraint);
            }
        }

        const isFeasible = rhs.every(constraint => lhs.includes(constraint));
        if (!isFeasible) {
            infeasibleCandidates.push(y);
            continue;
        }

        const incoming = activeVertices.filter((_, u) => u !== x && RV_adj[u][y] > 0);
        const update = MatrixContractionUpdate(
            activeVertices, RV_adj, RV_C, activeVertices[x], activeVertices[y], incoming
        );
        P_Total.push(activeVertices[y]);
        activeVertices = update.vertices;
        RV_adj = update.RV_adj;
        RV_C = update.RV_C;
        x = activeVertices.length - 1;
        infeasibleCandidates = [];
    }

    return { P_Total };
}