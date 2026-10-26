// Google Cloud side of the handlers, with the functions' own service account (spot-enroller): IAM, Resource Manager, Storage.
import { iam } from "@googleapis/iam";
import { cloudresourcemanager } from "@googleapis/cloudresourcemanager";
import { storage } from "@googleapis/storage";
import { GoogleAuth } from "google-auth-library";
import { DEFAULT_BUCKET, PROJECT_ID, addBinding, removeBinding, type Binding } from "./logic";
import type { Gcp, KeyResult } from "./ports";

const status = (e: unknown) => {
  const x = e as { code?: number | string; status?: number; response?: { status?: number } };
  return x.response?.status ?? x.status ?? (typeof x.code === "number" ? x.code : undefined);
};

interface Policy {
  version?: number | null;
  etag?: string | null;
  bindings?: Binding[] | null;
}

/** Read, change, write with the etag; try again if someone else changed the policy in between. */
export async function editPolicy(read: () => Promise<Policy>, write: (p: Policy) => Promise<unknown>, change: (p: Policy) => boolean) {
  for (let i = 1; ; i++) {
    const policy = await read();
    if (!change(policy)) return;
    // Version 3 keeps conditional bindings (like the one on spot-enroller itself) intact.
    policy.version = 3;
    try {
      await write(policy);
      return;
    } catch (e) {
      if (i >= 5 || (status(e) !== 409 && status(e) !== 412)) throw e;
    }
  }
}

export function googleGcp(project = PROJECT_ID, bucket = DEFAULT_BUCKET): Gcp {
  // Application default credentials: the runtime service account of the function.
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  // The three client packages can pin different google-auth-library versions; the object is the same at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = auth as any;
  const iamApi = iam({ version: "v1", auth: a });
  const crm = cloudresourcemanager({ version: "v1", auth: a });
  const gcs = storage({ version: "v1", auth: a });
  const saName = (email: string) => `projects/${project}/serviceAccounts/${email}`;
  const member = (email: string) => `serviceAccount:${email}`;

  return {
    async serviceAccountExists(email) {
      try {
        await iamApi.projects.serviceAccounts.get({ name: saName(email) });
        return true;
      } catch (e) {
        if (status(e) === 404) return false;
        throw e;
      }
    },
    async createServiceAccount(id, displayName, description) {
      await iamApi.projects.serviceAccounts.create({ name: `projects/${project}`, requestBody: { accountId: id, serviceAccount: { displayName, description } } });
    },
    async createKey(email): Promise<KeyResult> {
      const { data } = await iamApi.projects.serviceAccounts.keys.create({
        name: saName(email),
        requestBody: { keyAlgorithm: "KEY_ALG_RSA_2048", privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE" },
      });
      if (!data.privateKeyData || !data.name) throw new Error("Google returned no key");
      return { keyId: data.name.split("/").pop() ?? "", json: JSON.parse(Buffer.from(data.privateKeyData, "base64").toString("utf8")) };
    },
    async listUserKeyIds(email) {
      const { data } = await iamApi.projects.serviceAccounts.keys.list({ name: saName(email), keyTypes: ["USER_MANAGED"] });
      return (data.keys ?? []).map((k) => k.name?.split("/").pop() ?? "").filter(Boolean);
    },
    async deleteKey(email, keyId) {
      try {
        await iamApi.projects.serviceAccounts.keys.delete({ name: `${saName(email)}/keys/${keyId}` });
      } catch (e) {
        if (status(e) !== 404) throw e;
      }
    },
    async deleteServiceAccount(email) {
      try {
        await iamApi.projects.serviceAccounts.delete({ name: saName(email) });
      } catch (e) {
        if (status(e) !== 404) throw e;
      }
    },
    async setProjectRoles(email, mode, roles) {
      await editPolicy(
        async () => (await crm.projects.getIamPolicy({ resource: project, requestBody: { options: { requestedPolicyVersion: 3 } } })).data as Policy,
        (policy) => crm.projects.setIamPolicy({ resource: project, requestBody: { policy: policy as never } }),
        (p) => roles.map((r) => (mode === "add" ? addBinding(p, r, member(email)) : removeBinding(p, r, member(email)))).some(Boolean),
      );
    },
    async setBucketRoles(email, mode, roles) {
      await editPolicy(
        async () => (await gcs.buckets.getIamPolicy({ bucket, optionsRequestedPolicyVersion: 3 })).data as Policy,
        (policy) => gcs.buckets.setIamPolicy({ bucket, requestBody: policy as never }),
        (p) => roles.map((r) => (mode === "add" ? addBinding(p, r, member(email)) : removeBinding(p, r, member(email)))).some(Boolean),
      );
    },
  };
}
