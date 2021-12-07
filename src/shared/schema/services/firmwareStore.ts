import ky from "ky-universal";
import md5 from "md5";
import { unzipRaw, Reader, ZipInfoRaw } from "unzipit";
import config from "../../config";

const fakeUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Safari/537.36";

class HTTPRangeReader implements Reader {
  private url: string;
  private length?: number;

  constructor(url: string) {
    this.url = url;
  }

  async getLength() {
    if (this.length === undefined) {
      const req = await ky(this.url, {
        prefixUrl: config.proxyUrl,
        method: "HEAD",
        headers: {
          "user-agent": fakeUserAgent,
          // This really doesn't matter, we are just using something which might
          // help with slow requests
          Referer: "https://github.com/",
        },
      });
      if (!req.ok) {
        throw new Error(
          `failed http request ${this.url}, status: ${req.status}: ${req.statusText}`
        );
      }
      this.length = parseInt(req.headers.get("content-length")!);
      if (Number.isNaN(this.length)) {
        throw Error("could not get length");
      }
    }
    return this.length;
  }

  async read(offset: number, size: number) {
    if (size === 0) {
      return new Uint8Array(0);
    }
    const req = await ky(this.url, {
      prefixUrl: config.proxyUrl,
      headers: {
        Range: `bytes=${offset}-${offset + size - 1}`,
        "user-agent": fakeUserAgent,
        Referer: "https://github.com/",
      },
      timeout: 60000,
    });
    if (!req.ok) {
      throw new Error(
        `failed http request ${this.url}, status: ${req.status} offset: ${offset} size: ${size}: ${req.statusText}`
      );
    }
    const buffer = await req.arrayBuffer();
    return new Uint8Array(buffer);
  }
}

export type Target = {
  name: string;
  code: string;
};

type FirmwareFile = {
  targets: [string, string][];
};

const firmwareTargetsCache: Record<string, Promise<Target[]>> = {};

const firmwareBundle = (url: string): Promise<ZipInfoRaw> => {
  const reader = new HTTPRangeReader(url);
  return unzipRaw(reader as Reader);
};

export const firmwareTargets = async (
  firmwareBundleUrl: string
): Promise<Target[]> => {
  if (!firmwareTargetsCache[firmwareBundleUrl]) {
    firmwareTargetsCache[firmwareBundleUrl] = (async () => {
      try {
        const { entries } = await firmwareBundle(firmwareBundleUrl);
        const firmwareFile = entries.find((entry) =>
          entry.name.endsWith("fw.json")
        );

        if (!firmwareFile) {
          delete firmwareTargetsCache[firmwareBundleUrl];
          throw new Error("Could not find firmware metadata file");
        }

        const data = (await firmwareFile.json()) as FirmwareFile;

        return data.targets.map(([name, code]) => ({
          name,
          code: code.slice(0, code.length - 1),
        }));
      } catch (e) {
        delete firmwareTargetsCache[firmwareBundleUrl];
        throw e;
      }
    })();
  }

  return firmwareTargetsCache[firmwareBundleUrl];
};

export const fetchFirmware = async (
  firmwareBundleUrl: string,
  target: string
): Promise<Buffer> => {
  const { entries } = await firmwareBundle(firmwareBundleUrl);
  const firmwareFile = entries.find((entry) => entry.name.startsWith(target));
  if (!firmwareFile) {
    throw new Error("Could not find firmware target binary");
  }

  return Buffer.from(await firmwareFile.arrayBuffer());
};

const maxNumFirmwares = 4;
const uploadedFirmware: { id: string; data: Buffer }[] = [];

export const registerFirmware = (firmwareBuffer: Buffer): string => {
  const hash = md5(firmwareBuffer);
  uploadedFirmware.push({ id: hash, data: firmwareBuffer });

  if (uploadedFirmware.length > maxNumFirmwares) {
    uploadedFirmware.shift();
  }
  return hash;
};

export const getLocalFirmwareById = (id: string): Buffer | undefined =>
  uploadedFirmware.find((firmware) => firmware.id === id)?.data;
