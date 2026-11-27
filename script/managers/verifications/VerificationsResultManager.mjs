import Activity from "../../entities/activity/Activity.mjs";
import ArcGeometry from "../../entities/geometry/ArcGeometry.mjs";
import VisualArc from "../../entities/model/visual/VisualArc.mjs";
import VisualRDLTModel from "../../entities/model/visual/VisualRDLTModel.mjs";
import { generateUniqueID, pickRandomFromSet } from "../../utils.mjs";
import { BaseModelDrawingManager } from "../drawing/BaseModelDrawingManager.mjs";
import ModelContext from "../model/ModelContext.mjs";
import VERResultTabManager from "./panels/VERResultTabManager.mjs";
import VERSimulationTabManager from "./panels/VERSimulationTabManager.mjs";
import { VERSubworkspaceManager } from "./VERSubworkspaceManager.mjs";
import { PAESimulationManager } from "../activity/extraction/PAESimulationManager.mjs";
import { verifySoundness } from "../../services/soundness/soundness-service.mjs";

export class VerificationsResultManager {
  /** @type {ModelContext} */
  context;

  /** @type {string} */
  id;

  /**
   * @typedef {number} VertexUID
   * @typedef {number} ArcUID
   * @typedef {{
   *      title: string,
   *      instances: {
   *          name: string,
   *          evaluation: {
   *              conclusion: {
   *                  pass: boolean,
   *                  title: string,
   *                  description: string
   *              },
   *              criteria: {
   *                  pass: boolean,
   *                  description: string
   *              }[],
   *              kmax?: number,
   *              kmaxEnsuringResults?: {
   *                  level: number,
   *                  scope?: string,
   *                  pair?: string,
   *                  pass: boolean,
   *                  vertices?: VertexUID[],
   *                  esplits?: number,
   *                  esplitArcs?: [string, string][],
   *                  mergingJoins?: number,
   *                  expectedMergingJoins?: number,
   *                  separatingJoins?: number,
   *                  maxSeparatingJoins?: number,
   *                  reason?: string
   *              }[],
   *              violating: {
   *                  vertices: VertexUID[],
   *                  arcs: ArcUID[]
   *              },
   *              violatingRemarks?: {
   *                  vertices: { [vertexUID: number]: string },
   *                  arcs: { [arcUID: number]: string }
   *              },
   *          },
   *          model: {
   *              vertices: VertexUID[],
   *              arcs: ArcUID[],
   *          }
   *      }[]
   * }} VerificationResultData
   *
   * @type {VerificationResultData}
   */
  result;

  /** @type {VisualRDLTModel} */
  #modelSnapshot;

  /** @type {{ source: number, sink: number, notion: "classical" | "weak" | "kmax" } | null} */
  #soundnessConfig;

  /** @type {VERSubworkspaceManager} */
  #subworkspaceManager;

  /**
   * @type {{
   *      result: VERResultTabManager,
   *      simulation: VERSimulationTabManager|null
   * }}
   * */
  #panels;

  /** @type {BaseModelDrawingManager[]} */
  #drawingManagers = [];

  /** @type {BaseModelDrawingManager|null} */
  #simulationDrawingManager = null;

  #currentInstanceIndex = 0;
  #showingSimulation = false;

  /** @type {Object.<string, number>} */
  #simArcKeyToUID = {};
  /** @type {Object.<string, string>} seam-arc key → synthetic loop-arc drawing UID */
  #simLoopArcMap = {};
  /** @type {Object.<string, string>} entry/exit arc key → synthetic drawing UID */
  #simEntryExitArcMap = {};
  #simCurrentStep = 0;
  #simMaxStep = 0;

  /**
   * @param {ModelContext} context
   * @param {VerificationResultData} result
   * @param {*} visualModelSnapshot
   */
  constructor(
    context,
    result,
    visualModelSnapshot,
    activityProfile = null,
    soundnessConfig = null,
  ) {
    this.context = context;
    this.id = generateUniqueID();
    this.result = result;
    this.#modelSnapshot = visualModelSnapshot;
    this.activityProfile = activityProfile;
    this.#soundnessConfig = soundnessConfig;

    this.#initialize();
  }

  async #initialize() {
    const subworkspaceTabManager =
      await this.context.managers.workspace.addVerificationResultSubworkspace(
        this.id,
        this.result.title
      );
    const rootElement = subworkspaceTabManager.tabAreaElement;

    // this.#drawingManager = new AESDrawingManager(this, rootElement.querySelector(".drawing > svg"));
    this.#subworkspaceManager = new VERSubworkspaceManager(this, rootElement);

    this.#panels = {
      result: new VERResultTabManager(
        this,
        rootElement.querySelector(`[data-panel-id="result"]`)
      ),
      simulation: null,
    };

    const simulationPanelEl = rootElement.querySelector(`[data-panel-id="simulation"]`);
    if (simulationPanelEl && this.result._simulationData) {
      this.#panels.simulation = new VERSimulationTabManager(this, simulationPanelEl);
      const simulation = this.result.instances[0]?._meta?.simulation ?? null;
      this.#panels.simulation.display(simulation);
    }

    this.#panels.result.displayInstanceResult(this.result.instances[0]);

    const allVertices = this.#modelSnapshot.getAllComponents();
    const allArcs = this.#modelSnapshot.getAllArcs();

    // Initialize model drawings
    for (let i = 0; i < this.result.instances.length; i++) {
      const instance = this.result.instances[i];
      const drawingManager = new BaseModelDrawingManager(
        this.#subworkspaceManager.getInstanceSVG(i),
        "vs"
      );

      const vertices = instance.model?.vertices
        ? allVertices.filter((v) => instance.model?.vertices.includes(v.uid))
        : allVertices;

      // MAS instances: copy center vertices with isRBSCenter=false so the
      // RBS bounding box is not drawn (the RBS is collapsed into abstract arcs).
      const displayVertices = instance.model?.isMAS
        ? vertices.map(v => {
            if (!v.isRBSCenter) return v;
            const copy = v.copy();
            copy.isRBSCenter = false;
            return copy;
          })
        : vertices;

      const arcs = instance.model?.arcs
        ? allArcs.filter((v) => instance.model?.arcs.includes(v.uid))
        : allArcs;

      drawingManager.setupComponents(displayVertices, arcs, instance.options);

      // MAS instances: add abstract arcs as synthetic VisualArc objects.
      // They have synthetic UIDs (AA_...) so they can't be looked up in the
      // visual model — we construct them from the saved arc data instead.
      if (instance.model?.abstractArcs?.length) {
        const geomMap = {};
        displayVertices.forEach(v => { geomMap[v.uid] = v.geometry; });

        for (const aaData of instance.model.abstractArcs) {
          const fromGeom = geomMap[aaData.fromVertexUID];
          const toGeom   = geomMap[aaData.toVertexUID];
          if (!fromGeom || !toGeom) continue;

          const visualArc = new VisualArc({
            C:             aaData.C === 'E' ? '' : aaData.C,
            L:             aaData.L,
            fromVertexUID: aaData.fromVertexUID,
            toVertexUID:   aaData.toVertexUID,
            isAbstractArc: true,
          });

          drawingManager.addArc(visualArc, fromGeom, toGeom);
        }
      }

      // Highlight violating arcs
      const violatingArcsUIDs = instance.evaluation?.violating?.arcs || [];
      for (const arcUID of violatingArcsUIDs) {
        drawingManager.highlightArc(arcUID);
      }

      // Highlight violating vertices
      const violatingVerticesUIDs =
        instance.evaluation?.violating?.vertices || [];
      for (const vertexUID of violatingVerticesUIDs) {
        drawingManager.highlightVertex(vertexUID);
      }

      // Fit viewport to all drawn vertices so all components are visible on open
      drawingManager.fitToView(displayVertices.map(v => v.geometry));

      this.#drawingManagers.push(drawingManager);
    }

    // ── Simulation drawing — looped RDLT (original model + i/o dummies + synthetic arcs) ──
    const simData = this.result._simulationData;
    const simSVG  = this.#subworkspaceManager.getSimulationSVG();
    if (simData && simSVG) {
      // Build arc-key → VisualArc uid lookup for trace step-through.
      // Use "from->to:C" as the primary key so parallel arcs (same endpoints,
      // different C-values) resolve to the correct arc.  A plain "from->to"
      // fallback is stored for the first arc seen on each pair so that any
      // arc whose C-value doesn't survive the pipeline round-trip still
      // highlights something rather than nothing.
      for (const arc of allArcs) {
        const plainKey = `${arc.fromVertexUID}->${arc.toVertexUID}`;
        const cKey     = `${plainKey}:${arc.C}`;
        this.#simArcKeyToUID[cKey] = arc.uid;
        if (this.#simArcKeyToUID[plainKey] === undefined) {
          this.#simArcKeyToUID[plainKey] = arc.uid;
        }
      }
      this.#simMaxStep = simData.kPrime ?? (simData.trace?.length ?? 0);
      const simDrawingManager = new BaseModelDrawingManager(simSVG, "vs");
      simDrawingManager.setupComponents(allVertices, allArcs);

      // Geometry map for real vertices
      const geomMap = {};
      allVertices.forEach(v => { geomMap[v.uid] = v.geometry; });

      // Compute positions for dummy i/o vertices from real source/sink geometry.
      // Offset horizontally so i appears left of source and o right of sink.
      const sourceGeom = (simData.sourceVuids ?? []).map(uid => geomMap[uid]).find(Boolean);
      const sinkGeom   = (simData.sinkVuids   ?? []).map(uid => geomMap[uid]).find(Boolean);
      const DUMMY_OFFSET = 120;
      const DUMMY_SIZE   = sourceGeom?.size ?? 70;

      if (sourceGeom) {
        geomMap['i'] = {
          position: { x: sourceGeom.position.x - DUMMY_OFFSET, y: sourceGeom.position.y },
          size: DUMMY_SIZE,
        };
        simDrawingManager.addVertex({
          uid: 'i', type: 'c', identifier: 'i', label: '',
          styles: { outline: { width: 1 } },
          geometry: geomMap['i'],
        });
      }
      if (sinkGeom) {
        geomMap['o'] = {
          position: { x: sinkGeom.position.x + DUMMY_OFFSET, y: sinkGeom.position.y },
          size: DUMMY_SIZE,
        };
        simDrawingManager.addVertex({
          uid: 'o', type: 'c', identifier: 'o', label: '',
          styles: { outline: { width: 1 } },
          geometry: geomMap['o'],
        });
      }

      // Helper: draw a synthetic arc with a guaranteed-unique string UID so it
      // can never collide with numeric model-arc UIDs stored in builders.arcs.
      // Returns the assigned UID (needed for loop-arc highlighting).
      let _synIdx = 0;
      const addSimArc = (arcData, geometry) => {
        const fromGeom = geomMap[arcData.fromUID];
        const toGeom   = geomMap[arcData.toUID];
        if (!fromGeom || !toGeom) return null;
        const uid = `__sim_${_synIdx++}`;
        simDrawingManager.addArc(
          new VisualArc({ uid, C: '', L: arcData.l ?? 1, fromVertexUID: arcData.fromUID, toVertexUID: arcData.toUID, geometry }),
          fromGeom, toGeom
        );
        return uid;
      };

      for (const arc of (simData.entryArcs ?? [])) {
        const uid = addSimArc(arc);
        if (uid != null) this.#simEntryExitArcMap[`i->${arc.toUID}`] = uid;
      }
      for (const arc of (simData.exitArcs ?? [])) {
        const uid = addSimArc(arc);
        if (uid != null) this.#simEntryExitArcMap[`${arc.fromUID}->o`] = uid;
      }

      // Route loop arcs as a half-rectangle above the model: two waypoints placed
      // directly above each endpoint at the same Y so the path makes right-angle
      // corners (sink → up → across → down → source) instead of diagonal cuts.
      const loopRoutePoints = [];
      if ((simData.loopArcs ?? []).length > 0) {
        const allPositions = allVertices.map(v => v.geometry?.position).filter(Boolean);
        const modelMinY = allPositions.length > 0 ? Math.min(...allPositions.map(p => p.y)) : 0;
        const routeY = modelMinY - 100;

        for (const arc of simData.loopArcs) {
          const fromGeom = geomMap[arc.fromUID];
          const toGeom   = geomMap[arc.toUID];
          if (!fromGeom || !toGeom) continue;
          loopRoutePoints.push(
            { position: { x: fromGeom.position.x, y: routeY }, size: 0 },
            { position: { x: toGeom.position.x,   y: routeY }, size: 0 },
          );
          const loopUID = addSimArc(arc, new ArcGeometry({
            waypoints: [
              { x: fromGeom.position.x, y: routeY },
              { x: toGeom.position.x,   y: routeY },
            ],
          }));
          if (loopUID != null) {
            this.#simLoopArcMap[`${arc.fromUID}->${arc.toUID}`] = loopUID;
          }
        }
      }

      // Fit viewport to all simulation content: real vertices, dummy i/o, and loop
      // arc routing points above the model so nothing is clipped.
      const simGeometries = [
        ...allVertices.map(v => v.geometry),
        ...(geomMap['i'] ? [geomMap['i']] : []),
        ...(geomMap['o'] ? [geomMap['o']] : []),
        ...loopRoutePoints,
      ];
      simDrawingManager.fitToView(simGeometries);

      this.#simulationDrawingManager = simDrawingManager;
    }

    this.displayInstanceResult(0);
  }

  get canSimulateKmaxPAE() {
    return this.#soundnessConfig?.notion === "kmax"
      && this.result.instances[0]?.evaluation?.criteria?.[0]?.pass !== false;
  }

  get canShowKmaxEnsuringResults() {
    return this.#soundnessConfig?.notion === "kmax"
      && this.result.instances[0]?.evaluation?.criteria?.[0]?.pass === true;
  }

  get canCheckKmax() {
    return ["classical", "weak"].includes(this.#soundnessConfig?.notion)
      && this.result.instances[0]?.evaluation?.conclusion?.pass === true
      && this.result.instances[0]?.evaluation?.theoreticalNote != null;
  }

  checkKmax() {
    if (!this.canCheckKmax || !this.#soundnessConfig) return;

    const { source, sink } = this.#soundnessConfig;
    const result = verifySoundness(
      this.#modelSnapshot.toSimpleModel(),
      source,
      sink,
      "kmax",
    );
    result.title = "kᵐᵃˣ Soundness Verification";
    this.context.managers.workspace.showVerificationResults(
      result,
      this.#modelSnapshot,
      null,
      { source, sink, notion: "kmax" },
    );
  }

  async simulateKmaxPAE() {
    if (!this.#soundnessConfig) return;

    const { source, sink } = this.#soundnessConfig;
    const paeManager = new PAESimulationManager(
      this.context,
      { name: "kmax-soundness PAE", source, sink },
      this.#modelSnapshot,
    );
    await paeManager.ready;

    const conclusion = paeManager.getConclusion();
    const competingArcUIDs = [...paeManager.getCompetingArcUIDs()];
    const interruptingArcUIDs = [...paeManager.getInterruptingArcUIDs()];
    const entries = paeManager.isParallel
      ? paeManager.getProcessEntriesForGroup(0)
      : paeManager.getProcessEntries();

    if (entries.length === 0) {
      alert(`PAE could not produce any activities.\n\n${conclusion.title}: ${conclusion.description}`);
      return;
    }

    const parallelGroupId = crypto.randomUUID();
    const activities = entries.map((entry, index) => new Activity({
      name: entries.length === 1
        ? "kmax-soundness PAE"
        : `kmax-soundness PAE — Process ${index + 1}`,
      source,
      sink,
      origin: "pae",
      parallelGroupId,
      conclusion,
      profile: entry.activityProfile,
      tor: {},
      competingArcUIDs,
      interruptingArcUIDs,
    }));

    if (activities.length > 1) {
      this.context.managers.workspace.startParallelActivitySimulation(activities);
    } else {
      this.context.managers.workspace.startActivitySimulation(activities[0]);
    }
  }

  getVertexIdentifier(vertexUID) {
    return this.#modelSnapshot.getComponent(vertexUID)?.identifier || "";
  }

  /**
   * @returns {[ string, string ]}
   */
  getArcIdentifierPair(arcUID) {
    const arc = this.#modelSnapshot.getArc(arcUID);
    if (!arc) return ["", ""];

    const from = this.getVertexIdentifier(arc.fromVertexUID);
    const to = this.getVertexIdentifier(arc.toVertexUID);

    return [from, to];
  }

  displayInstanceResult(instanceIndex) {
    const prevIndex = this.#currentInstanceIndex;
    this.#currentInstanceIndex = instanceIndex;
    const instance = this.result.instances[instanceIndex];

    // Swap drawings — hide simulation SVG if it was showing
    if (this.#showingSimulation) {
      this.#subworkspaceManager.getSimulationSVG()?.classList.remove("active");
      this.#showingSimulation = false;
    } else {
      this.#subworkspaceManager.getInstanceSVG(prevIndex).classList.remove("active");
    }
    this.#subworkspaceManager.getInstanceSVG(instanceIndex).classList.add("active");
    this.#drawingManagers[instanceIndex]?.viewport.refresh();

    // Set data attribute for highlight color: green for Shared Arc, red otherwise
    const root = this.#subworkspaceManager.getRootElement();
    if (instance.name === "Shared Arc") {
      root.setAttribute("data-ver-highlight", "shared");
    } else {
      root.removeAttribute("data-ver-highlight");
    }

    // Update result tab
    this.#panels.result.displayInstanceResult(instance);
  }

  showSimulationDrawing() {
    if (!this.#simulationDrawingManager) return;
    this.#subworkspaceManager.getInstanceSVG(this.#currentInstanceIndex).classList.remove("active");
    this.#subworkspaceManager.getSimulationSVG().classList.add("active");
    this.#simulationDrawingManager.viewport.refresh();
    this.#showingSimulation = true;
  }

  showInstanceDrawing() {
    if (!this.#showingSimulation) return;
    this.#subworkspaceManager.getSimulationSVG()?.classList.remove("active");
    this.#subworkspaceManager.getInstanceSVG(this.#currentInstanceIndex).classList.add("active");
    this.#showingSimulation = false;
  }
  handleSimulateMAE(view) {
    this.context.managers.workspace.startActivitySimulation(new Activity({
      name: "Activity from Well-Handledness",
      origin: "direct",
      profile: this.activityProfile
    }));

    return;

    view.modal.style.display = "block";
    const body = view.modal.querySelector(".modal-body");
    body.innerHTML = ""; // Clear previous content

    for (const key in this.activityProfile) {
      const valueSet = this.activityProfile[key];
      // Create a container div to hold the arcTag
      const wrapper = document.createElement("div");
      wrapper.style.display = "block"; // Force block display

      const timeStep = document.createElement("label");
      timeStep.style.display = "inline-block"; // Make label inline
      timeStep.innerText = `S(${key}): `;

      wrapper.appendChild(timeStep); // Append timeStep to the wrapper
      for (const value of valueSet) {
        const arc = this.#modelSnapshot.getArc(value);
        if (!arc) return ["", ""];

        const fromVertex = this.getVertexIdentifier(arc.fromVertexUID);
        const toVertex = this.getVertexIdentifier(arc.toVertexUID);

        const arcTag = document.createElement("div");
        arcTag.className = "arc-tag";
        arcTag.style.display = "inline-block"; // Set display to inline-block

        const from = document.createElement("div");
        from.className = "arc-tag-from";
        from.textContent = fromVertex;

        const to = document.createElement("div");
        to.className = "arc-tag-to";
        to.textContent = toVertex;

        arcTag.appendChild(from);
        arcTag.appendChild(to);

        wrapper.appendChild(arcTag); // Place arcTag inside the wrapper
        body.appendChild(wrapper);
      }
    }

    // Simulate MAE logic here
    console.log("Simulate MAE:", this.activityProfile);
  }

  setSimulationTimestep(t) {
    if (!this.#simulationDrawingManager) return;
    this.#simCurrentStep = t;
    this.#simulationDrawingManager.clearHighlights();

    const simData = this.result._simulationData;
    const trace   = simData?.trace ?? [];
    const stepLog = trace[t - 1];
    if (stepLog) {
      const impedanceKeys = new Set((stepLog.impedances ?? []).map(imp => imp.arc));
      for (const arcData of (stepLog.arcs ?? [])) {
        const isImpedance = impedanceKeys.has(arcData.key);
        if (arcData.type === 'entry' || arcData.type === 'exit') {
          const synUID = this.#simEntryExitArcMap[arcData.key];
          if (synUID != null) this.#simulationDrawingManager.highlightArc(synUID, null, isImpedance);
          continue;
        }
        if (arcData.type === 'seam') {
          const loopUID = this.#simLoopArcMap[arcData.key];
          if (loopUID != null) this.#simulationDrawingManager.highlightArc(loopUID, null, isImpedance);
          continue;
        }
        const uid = this.#simArcKeyToUID[`${arcData.key}:${arcData.c ?? ''}`]
                 ?? this.#simArcKeyToUID[arcData.key];
        if (uid != null) this.#simulationDrawingManager.highlightArc(uid, null, isImpedance);
      }
    }

    this.#panels.simulation?.updateStep(t, this.#simMaxStep);
  }

  prevSimulationStep() {
    if (this.#simCurrentStep > 1) this.setSimulationTimestep(this.#simCurrentStep - 1);
  }

  nextSimulationStep() {
    if (this.#simCurrentStep < this.#simMaxStep) this.setSimulationTimestep(this.#simCurrentStep + 1);
  }

  closeSimulateMAE(view) {
    view.modal.style.display = "none";
  }
}
