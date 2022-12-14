export interface DockerFileAnalysis {
  baseImage?: string;
  dockerfilePackages: DockerFilePackages;
  dockerfileLayers: DockerFileLayers;
  error?: {
    code: DockerFileAnalysisErrorCode;
  };
}

export enum DockerFileAnalysisErrorCode {
  BASE_IMAGE_NAME_NOT_FOUND = "BASE_IMAGE_NAME_NOT_FOUND",
  BASE_IMAGE_NON_RESOLVABLE = "BASE_IMAGE_NON_RESOLVABLE",
}

export interface DockerFilePackages {
  [packageName: string]: {
    instruction: string;
    installCommand: string;
  };
}

export interface DockerFileLayers {
  [id: string]: {
    instruction: string;
  };
}

export interface GetDockerfileBaseImageNameResult {
  baseImage?: string;
  error?: GetDockerfileBaseImageNameResultError;
}

export interface GetDockerfileBaseImageNameResultError {
  code: DockerFileAnalysisErrorCode;
}

export interface UpdateDockerfileBaseImageNameResult {
  contents: string;
  error?: UpdateDockerfileBaseImageNameError;
}

export interface UpdateDockerfileBaseImageNameError {
  code: UpdateDockerfileBaseImageNameErrorCode;
}

export enum UpdateDockerfileBaseImageNameErrorCode {
  BASE_IMAGE_NAME_FRAGMENTED = "BASE_IMAGE_NAME_FRAGMENTED",
  BASE_IMAGE_NAME_NOT_FOUND = "BASE_IMAGE_NAME_NOT_FOUND",
  DOCKERFILE_GENERATION_FAILED = "DOCKERFILE_GENERATION_FAILED",
}
