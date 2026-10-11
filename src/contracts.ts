export type Algorithm = 'quick' | 'insertion' | 'bubble' | 'selection' | 'bogo';
export type StepKind = 'partition' | 'compare' | 'advance' | 'swap' | 'pivotPlaced' | 'rangeComplete' | 'complete';
export interface SortStep { kind: StepKind; values: number[]; sorted: boolean[]; lo: number; hi: number; i: number; j: number; pivotIndex: number; pivotValue: number; comparisons: number; swaps: number; codeLine: number; swapA: number; swapB: number; message: string; }
export interface PlaybackState { algorithm: Algorithm; step: SortStep; index: number; count: number; playing: boolean; speed: number; elementCount: number; exhausted: boolean; transition: number; animating: boolean; landing: number; idleTime: number; celebrationTime: number; delta: number; revision: number; }
export interface AudioSettings { master: number; voice: number; effects: number; music: number; muted: boolean; }
export interface ActorProjection { value: number; x: number; y: number; groundX: number; groundY: number; shadowWidth: number; lift: number; }
export interface StageProjection { actors: ActorProjection[]; slots: number[]; groundY: number; rangeLeft: number; rangeRight: number; }
export interface RigNode { name: string; parent: number; position: number[]; rotation: number[]; scale: number[]; }
export interface RigMaterial { name: string; shader: string; texture: string | null; emissive: string | null; color: number[]; emissiveColor: number[]; outlineColor: number[]; outlineWidth: number; saturation: number; queue: number; uv: number[]; stencilRef: number; stencilComp: number; stencilOp: number; }
export interface RigMesh { name: string; node: number; rootBone: number; bounds: { center: number[]; extents: number[] }; positions: number[]; normals: number[]; uv: number[]; indices: number[]; groups: {start: number; count: number; materialIndex: number}[]; materials: number[]; bones: number[]; bindposes: number[][]; weights: number[]; joints: number[]; }
export interface RigTrack { node: number; property: 'position' | 'quaternion' | 'scale'; times: number[]; values: number[]; }
export interface RigClip { name: 'idle' | 'dance' | 'jump'; duration: number; tracks: RigTrack[]; }
export interface RigAsset { id: number; nodes: RigNode[]; meshes: RigMesh[]; materials: RigMaterial[]; clips: RigClip[]; }
