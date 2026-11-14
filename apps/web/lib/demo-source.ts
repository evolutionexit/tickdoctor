import type { DemoDataset } from "./demo-types";
import dataset from "../content/demo/dataset.json";

/** The demo reads only this committed file: no API calls, nothing online. */
export async function loadDemoDataset(): Promise<DemoDataset> {
  return dataset as unknown as DemoDataset;
}
