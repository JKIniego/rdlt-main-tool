import Activity from "../../entities/activity/Activity.mjs";
import VisualRDLTModel from "../../entities/model/visual/VisualRDLTModel.mjs";
import { generateUniqueID, pickRandomFromSet } from "../../utils.mjs";
import { BaseModelDrawingManager } from "../drawing/BaseModelDrawingManager.mjs";
import ModelContext from "../model/ModelContext.mjs";
import VERResultTabManager from "./panels/VERResultTabManager.mjs";
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
   *      result: VERResultTabManager
   * }}
   * */
  #panels;

  /** @type {BaseModelDrawingManager[]} */
  #drawingManagers = [];

  #currentInstanceIndex = 0;

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
    };

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

      const arcs = instance.model?.arcs
        ? allArcs.filter((v) => instance.model?.arcs.includes(v.uid))
        : allArcs;

      drawingManager.setupComponents(vertices, arcs, instance.options);

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

      this.#drawingManagers.push(drawingManager);
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

    // Change visible drawing
    this.#subworkspaceManager
      .getInstanceSVG(prevIndex)
      .classList.remove("active");
    this.#subworkspaceManager
      .getInstanceSVG(instanceIndex)
      .classList.add("active");

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

  closeSimulateMAE(view) {
    view.modal.style.display = "none";
  }
}
