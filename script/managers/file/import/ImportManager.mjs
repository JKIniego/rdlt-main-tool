import App from "../../../App.mjs";
import ModelContext from "../../model/ModelContext.mjs";
import ActivityImportManager from "./ActivityImportManager.mjs";
import RDLTImportManager from "./RDLTImportManager.mjs";

export default class ImportManager {
    /** @type { ModelContext } */
    context;

    /**
     * @param {ModelContext} context 
     */
    constructor(context) {
        this.context = context;
    }

    async importRDLTFile() {
        const filesData = await this.#importFilesThenRead(".txt", true);
        if(!filesData) return;

        for(const fileData of filesData) {
            const modelName = fileData.name.replace(/\.[^.]+$/, "");
            const visualModel = RDLTImportManager.loadRDLTModel(fileData.text, modelName);
            if(!visualModel) continue;

            await App.addContext(visualModel);
        }
    }

    async importActivityFile() {
        const [fileData] = await this.#importFilesThenRead();
        if(!fileData) return;

        const activity = ActivityImportManager.loadActivity(fileData.text);
        if(!activity) return;

        this.context.managers.activities.addActivity(activity);
    }

    #importFilesThenRead(accept = ".txt", multiple = false) {
        return new Promise((resolve, reject) => {
            const importField = document.createElement("input");
            importField.type = "file";
            importField.accept = accept;
            importField.multiple = multiple;

            importField.addEventListener("change", (event) => {
                importField.remove();

                const files = Array.from(event.target.files || []);
                if(files.length === 0) return resolve([]);

                Promise.all(files.map(file => new Promise((resolveFile, rejectFile) => {
                    const reader = new FileReader();
                    reader.onload = () => resolveFile({
                        text: reader.result,
                        name: file.name
                    });
                    reader.onerror = () => rejectFile(
                        reader.error || new Error(`Failed to read ${file.name}.`)
                    );

                    reader.readAsText(file);
                }))).then(resolve, reject);
            });

            importField.addEventListener("cancel", () => {
                importField.remove();
                resolve([]);
            });

            document.querySelector("#tmp").appendChild(importField);
            importField.click();
        });
    }
}

