import * as depGraph from "@snyk/dep-graph";
import { eventLoopSpinner } from "event-loop-spinner";
import * as path from "path";
import * as varint from "varint";

import { DEP_GRAPH_TYPE } from "./";
import { GoModule } from "./go-module";
import { LineTable } from "./pclntab";
import { Elf, ElfProgram } from "./types";

export class GoBinary {
  public name: string;
  public modules: GoModule[];

  constructor(goElfBinary: Elf) {
    [this.name, this.modules] = extractModuleInformation(goElfBinary);

    const pclnTab = goElfBinary.body.sections.find(
      (section) => section.name === ".gopclntab",
    );

    // some CGo built binaries might not contain a pclnTab, which means we
    // cannot scan the files.
    // TODO: from a technical perspective, it would be enough to only report the
    // modules, as the only remediation path is to upgrade a full module
    // anyways. From a product perspective, it's not clear (yet).
    if (pclnTab === undefined) {
      throw Error("no pcln table present in Go binary");
    }

    this.matchFilesToModules(new LineTable(pclnTab.data).go12MapFiles());
  }

  public async depGraph(): Promise<depGraph.DepGraph> {
    const goModulesDepGraph = new depGraph.DepGraphBuilder(
      { name: DEP_GRAPH_TYPE },
      { name: this.name },
    );

    for (const module of this.modules) {
      for (const pkg of module.packages) {
        if (eventLoopSpinner.isStarving()) {
          await eventLoopSpinner.spin();
        }

        const nodeId = `${pkg}@${module.version}`;
        goModulesDepGraph.addPkgNode(
          { name: pkg, version: module.version },
          nodeId,
        );
        goModulesDepGraph.connectDep(goModulesDepGraph.rootNodeId, nodeId);
      }
    }

    return goModulesDepGraph.build();
  }

  // matchFilesToModules goes through all files, extracts the package name and
  // adds it to the relevant module in the GoBinary.
  public matchFilesToModules(files: string[]): void {
    const { modCachePath, vendorPath } = determinePaths(this.modules, files);
    for (const fileName of files) {
      if (fileName === "<autogenerated>") {
        continue;
      }

      let moduleName = (mod: GoModule): string => mod.fullName();
      let pkgFile = "";
      if (vendorPath && fileName.startsWith(vendorPath)) {
        moduleName = (mod: GoModule): string => mod.name;
        pkgFile = trimPrefix(fileName, vendorPath);
      } else if (modCachePath && fileName.startsWith(modCachePath)) {
        moduleName = (mod: GoModule): string => mod.fullName();
        pkgFile = trimPrefix(fileName, modCachePath);
      } else if (!vendorPath && !modCachePath) {
        // is trimmed
        pkgFile = fileName;
      } else {
        // skip file, probably a file from the Go source.
        continue;
      }

      // Try to find the module that matches our file name, and if found,
      // extract the package name out of it.
      // Go source files will not be matched by any module, so they will be
      // skipped automatically.
      for (const module of this.modules) {
        const modFullName = moduleName(module);
        if (pkgFile.startsWith(modFullName)) {
          // For example, the filename "github.com/my/pkg@v0.0.1/a/a.go" will be
          // split into "github.com/my/pkg@v0.0.1/" and "a/a.go". We then get
          // the package name from the package and file section, and add the
          // normalized module name (without the version) in front. This will
          // result in the package name "github.com/my/pkg/a".
          const parts = pkgFile.split(modFullName);
          if (parts.length !== 2 || parts[0] !== "") {
            throw {
              fileName: pkgFile,
              moduleName: modFullName,
            } as GoFileNameError;
          }

          // for files in the "root" of a module
          // (github.com/my/pkg@v0.0.1/a.go), the path.parse expression returns
          // just a slash. This would result in a package name with a trailing
          // slash, which is incorrect.
          let dirName = path.parse(parts[1]).dir;
          if (dirName === "/") {
            dirName = "";
          }

          const pkgName = module.name + dirName;
          if (!module.packages.includes(pkgName)) {
            module.packages.push(pkgName);
          }
        }
      }
    }
  }
}

interface GoFileNameError extends Error {
  fileName: string;
  moduleName: string;
}

export function extractModuleInformation(
  binary: Elf,
): [name: string, deps: GoModule[]] {
  const mod = readRawBuildInfo(binary);
  if (!mod) {
    throw Error("binary contains empty module info");
  }

  const [pathDirective, mainModuleLine, ...versionsLines] = mod.split("\n");
  const lineSplit = mainModuleLine.split("\t");
  let name = lineSplit[1];
  if (lineSplit[0] !== "mod") {
    // If the binary has no mod directive, it is a binary from the Go
    // distribution, like the "go" command, "vet", "gofmt" or others. In that
    // case, we use "go-distribution@" plus the path directive ("cmd/vet" for
    // example) as the name.  Using the "@" ensures that customers cannot create
    // name-clashes with these as "@" is an invalid character in Go modules.
    name = "go-distribution@" + pathDirective.split("\t")[1];
  }

  const modules: GoModule[] = [];
  versionsLines.forEach((versionLine) => {
    const [, name, ver] = versionLine.split("\t");
    if (!name || !ver) {
      return;
    }

    modules.push(new GoModule(name, ver));
  });

  return [name, modules];
}

// Source
// https://cs.opensource.google/go/go/+/refs/tags/go1.18.5:src/debug/buildinfo/buildinfo.go;l=142
/**
 * Function finds and returns the Go version and
 * module version information in the executable binary
 * @param binary
 */
export function readRawBuildInfo(binary: Elf): string {
  const buildInfoMagic = "\xff Go buildinf:";
  // Read the first 64kB of dataAddr to find the build info blob.
  // On some platforms, the blob will be in its own section, and DataStart
  // returns the address of that section. On others, it's somewhere in the
  // data segment; the linker puts it near the beginning.
  const dataAddr = dataStart(binary);
  let data =
    readData(binary.body.programs, dataAddr, 64 * 1024) || Buffer.from([]);

  const buildInfoAlign = 16;
  const buildInfoSize = 32;

  while (true) {
    const i = data.toString("binary").indexOf(buildInfoMagic);
    if (i < 0 || data.length - i < buildInfoSize) {
      throw Error("not a Go executable");
    }
    if (i % buildInfoAlign === 0 && data.length - i >= buildInfoSize) {
      data = data.subarray(i);
      break;
    }
    data = data.subarray((i + buildInfoAlign - 1) & ~buildInfoAlign);
  }

  // Decode the blob.
  // The first 14 bytes are buildInfoMagic.
  // The next two bytes indicate pointer size in bytes (4 or 8) and endianness
  // (0 for little, 1 for big).
  // Two virtual addresses to Go strings follow that: runtime.buildVersion,
  // and runtime.modinfo.
  // On 32-bit platforms, the last 8 bytes are unused.
  // If the endianness has the 2 bit set, then the pointers are zero
  // and the 32-byte header is followed by varint-prefixed string data
  // for the two string values we care about.
  const ptrSize = data[14];
  if ((data[15] & 2) !== 0) {
    data = data.subarray(32);
    [, data] = decodeString(data);
    const [mod] = decodeString(data);
    return mod;
  } else {
    const bigEndian = data[15] !== 0;

    let readPtr: ReadPtrFunc;
    if (ptrSize === 4) {
      if (bigEndian) {
        readPtr = (buffer) => buffer.readUInt32BE(0);
      } else {
        readPtr = (buffer) => buffer.readUInt32LE(0);
      }
    } else {
      if (bigEndian) {
        readPtr = (buffer) => Number(buffer.readBigUInt64BE());
      } else {
        readPtr = (buffer) => Number(buffer.readBigUInt64LE());
      }
    }

    // The build info blob left by the linker is identified by
    // a 16-byte header, consisting of buildInfoMagic (14 bytes),
    // the binary's pointer size (1 byte),
    // and whether the binary is big endian (1 byte).
    // Now we attempt to read info after metadata.
    // From 16th byte to 16th + ptrSize there is a header that points
    // to go version
    const version: string = readString(
      binary,
      ptrSize,
      readPtr,
      readPtr(data.slice(16, 16 + ptrSize)),
    );

    if (version === "") {
      throw Error("no version found in go binary");
    }

    // Go version header was right after metadata.
    // Modules header right after go version
    // Read next `ptrSize` bytes, this point to the
    // place where modules info is stored
    const mod: string = readString(
      binary,
      ptrSize,
      readPtr,
      readPtr(data.slice(16 + ptrSize, 16 + 2 * ptrSize)),
    );

    // This verifies that what we got are actually go modules
    // First 16 bytes are unicodes as last 16
    // Mirrors go version source code
    if (mod.length >= 33 && mod[mod.length - 17] === "\n") {
      return mod.slice(16, mod.length - 16);
    } else {
      throw Error("binary is not built with go module support");
    }
  }
}

function decodeString(data: Buffer): [string, Buffer] {
  const num = varint.decode(data);
  const size = varint.decode.bytes;
  if (size <= 0 || num >= data.length - size) {
    return ["", Buffer.from([])];
  }
  const res = data.subarray(size, num + size);
  const rest = data.subarray(num + size);
  return [res.toString("binary"), rest];
}

// Source
// https://github.com/golang/go/blob/46f99ce7ea97d11b0a1a079da8dda0f51df2a2d2/src/cmd/go/internal/version/exe.go#L105
/**
 * Find start of section that contains module version data
 * @param binary
 */
function dataStart(binary: Elf): number {
  for (const section of binary.body.sections) {
    if (section.name === ".go.buildinfo") {
      return section.addr;
    }
  }

  for (const program of binary.body.programs) {
    if (program.type === "load" && program.flags.w === true) {
      return program.vaddr;
    }
  }

  return 0;
}

// Source
// https://github.com/golang/go/blob/46f99ce7ea97d11b0a1a079da8dda0f51df2a2d2/src/cmd/go/internal/version/exe.go#L87
/**
 * Read at most `size` of bytes from `program` that contains byte at `addr`
 * @param programs
 * @param addr
 * @param size
 */
function readData(
  programs: ElfProgram[],
  addr: number,
  size: number,
): Buffer | undefined {
  for (const program of programs) {
    const vaddr = program.vaddr;
    const filesz = program.filesz;
    if (vaddr <= addr && addr <= vaddr + filesz - 1) {
      let n = vaddr + filesz - addr;

      if (n > size) {
        n = size;
      }

      const from = addr - vaddr; // offset from the beginning of the program

      return program.data.slice(from, from + n);
    }
  }

  return undefined;
}

type ReadPtrFunc = (Buffer) => number;

// Source
// https://github.com/golang/go/blob/46f99ce7ea97d11b0a1a079da8dda0f51df2a2d2/src/cmd/go/internal/version/version.go#L189
/**
 * Function returns the string at address addr in the executable x
 * @param binaryFile
 * @param ptrSize
 * @param readPtr
 * @param addr
 */
function readString(
  binaryFile: Elf,
  ptrSize: number,
  readPtr: ReadPtrFunc,
  addr: number,
): string {
  const hdr = readData(binaryFile.body.programs, addr, 2 * ptrSize);
  if (!hdr || hdr.length < 2 * ptrSize) {
    return "";
  }

  const dataAddr = readPtr(hdr);
  const dataLen = readPtr(hdr.slice(ptrSize));

  const data = readData(binaryFile.body.programs, dataAddr, dataLen);

  if (!data || data.length < dataLen) {
    return "";
  }

  return data.toString("binary");
}

function isTrimmed(files: string[]): boolean {
  // the easiest way to detect trimmed binaries: the filenames will all be
  // relative.
  // There usually is a `build` line in the Go binary's metadata that denotes
  // whether `trimpath` has been used or not, but there are binaries out there
  // that have trimmed paths without that annotation (for example
  // kyverno@v1.8.1).
  return files.every((file) => !file.startsWith("/"));
}

// determinePaths returns the modCachePath and vendorPath for a binary.
// goModCachePath is the path at which the modules are downloaded to. When
// building a Go binary, this is usually either $GOMODCACHE or
// $GOROOT/pkg/mod.
// The vendorPath is the path where vendored files are located, which is usually
// the main module's location + "/vendor".
//
// Binaries built with `-trimpath` will have all paths trimmed away, meaning
// that both returned values will be empty.
export function determinePaths(
  modules: GoModule[],
  files: string[],
): { modCachePath: string; vendorPath: string } {
  if (isTrimmed(files)) {
    return { modCachePath: "", vendorPath: "" };
  }

  return {
    modCachePath: determineGoModCachePath(modules, files),
    vendorPath: determineVendorPath(modules, files),
  };
}

function determineVendorPath(modules: GoModule[], files: string[]): string {
  // to determine the vendor path, we search for a file that contains
  // `vendor/<module name>`. This file also contains the "root" of the
  // repository, e.g. `/app/vendor/<module-name>`. This means that the `main`
  // package is located somewhere in `/app/...`.
  // We check for other files in that root to make sure that we really got the
  // right vendor folder, and not just a random folder named `vendor` somewhere.
  for (const [, mod] of Object.entries(modules)) {
    const vendoredModulePath = path.join("vendor", mod.name) + "/";
    const file = files.find((file) => file.includes(vendoredModulePath));
    if (file) {
      // make sure that we find other files in that path not in the vendor
      // folder.
      const mainModulePath = file.split(vendoredModulePath)[0];
      const success = files.find(
        (file) =>
          file.includes(mainModulePath) && !file.includes(vendoredModulePath),
      );
      if (success) {
        return path.join(mainModulePath, "vendor") + "/";
      }
    }
  }
  return "";
}

function determineGoModCachePath(modules: GoModule[], files: string[]): string {
  // files in the go mod cache path always contain the module name and version.
  for (const [, mod] of Object.entries(modules)) {
    const file = files.find((file) => file.includes("/" + mod.fullName()));
    if (file) {
      return file.split(mod.fullName())[0];
    }
  }
  return "";
}

function trimPrefix(s: string, prefix: string): string {
  if (s.startsWith(prefix)) {
    return s.substring(prefix.length);
  }
  return s;
}