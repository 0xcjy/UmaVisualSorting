import * as THREE from 'three';
import type { ActorProjection, PlaybackState, RigAsset, RigMaterial, RigMesh, StageProjection } from './contracts';
import { SecondaryMotion, type BoundRigMesh } from './secondary-motion';

const POSE_PATHS = [
  'Position/Hip/Waist/Chest/Neck',
  'Position/Hip/Waist/Chest/Shoulder_L/Arm_L',
  'Position/Hip/Waist/Chest/Shoulder_R/Arm_R',
  'Position/Hip/Waist/Chest/Shoulder_L/Arm_L/Elbow_L',
  'Position/Hip/Waist/Chest/Shoulder_R/Arm_R/Elbow_R',
  'Position/Hip/Waist/Chest/Shoulder_L/Arm_L/Elbow_L/Wrist_L',
  'Position/Hip/Waist/Chest/Shoulder_R/Arm_R/Elbow_R/Wrist_R',
  'Position/Hip/Waist/Chest',
];
const NECK = 0, LEFT_ARM = 1, RIGHT_ARM = 2, LEFT_ELBOW = 3, RIGHT_ELBOW = 4, LEFT_WRIST = 5, RIGHT_WRIST = 6, CHEST = 7;
const clamp = THREE.MathUtils.clamp;
const radians = THREE.MathUtils.degToRad;
const VERTEX_SHADER = `
#include <common>
#include <skinning_pars_vertex>
uniform vec4 uvTransform;
uniform vec2 expressionOffset;
uniform float outlineWidth;
varying vec2 vUmaUv;
void main() {
  vUmaUv = uv * uvTransform.xy + uvTransform.zw + expressionOffset;
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  transformed += objectNormal * outlineWidth;
  #include <project_vertex>
}
`;
const FRAGMENT_SHADER = `
uniform sampler2D diffuseMap;
uniform sampler2D emissiveMap;
uniform vec4 charaColor;
uniform vec4 emissiveColor;
uniform vec3 outlineColor;
uniform float saturation;
uniform bool bodyMaterial;
uniform bool outlinePass;
varying vec2 vUmaUv;
void main() {
  vec4 texel = texture2D(diffuseMap, vUmaUv);
  vec4 base = texel * charaColor;
  if (outlinePass) {
    gl_FragColor = vec4(mix(outlineColor, texel.rgb, 0.2), 1.0);
  } else {
    if (bodyMaterial) {
      float gray = dot(base.rgb, vec3(0.299, 0.587, 0.114));
      vec4 emission = texture2D(emissiveMap, vUmaUv) * emissiveColor;
      base.rgb = mix(vec3(gray), base.rgb, clamp(saturation, 0.0, 1.0)) + emission.rgb * emission.a;
    }
    gl_FragColor = base;
  }
  // Unity project uses Gamma color space: retain the authored shader arithmetic.
}
`;
const STENCIL_FUNCTIONS: THREE.StencilFunc[] = [THREE.AlwaysStencilFunc, THREE.NeverStencilFunc, THREE.LessStencilFunc, THREE.EqualStencilFunc, THREE.LessEqualStencilFunc, THREE.GreaterStencilFunc, THREE.NotEqualStencilFunc, THREE.GreaterEqualStencilFunc, THREE.AlwaysStencilFunc];
const STENCIL_OPERATIONS: THREE.StencilOp[] = [THREE.KeepStencilOp, THREE.ZeroStencilOp, THREE.ReplaceStencilOp, THREE.IncrementStencilOp, THREE.DecrementStencilOp, THREE.InvertStencilOp, THREE.IncrementWrapStencilOp, THREE.DecrementWrapStencilOp];

interface MeshResource { source: RigMesh; geometry: THREE.BufferGeometry; inverses: THREE.Matrix4[] | null; bind: THREE.Matrix4 | null; }
interface ModelResource {
  asset: RigAsset; meshes: MeshResource[]; materials: THREE.ShaderMaterial[];
  outlines: THREE.ShaderMaterial[]; clips: Record<'idle' | 'dance' | 'jump', THREE.AnimationClip>;
  bounds: THREE.Box3 | null;
  roots: number[];
}
interface Actor {
  value: number; root: THREE.Group; model: THREE.Group; nodes: THREE.Bone[];
  skeletons: THREE.Skeleton[];
  mixer: THREE.AnimationMixer; actions: Record<'idle' | 'dance' | 'jump', THREE.AnimationAction>;
  ownMaterials: THREE.ShaderMaterial[];
  eyes: THREE.ShaderMaterial; mouth: THREE.ShaderMaterial;
  poseBones: THREE.Bone[]; bindRotations: THREE.Quaternion[]; nativeRotations: THREE.Quaternion[];
  poseOffsets: THREE.Quaternion[]; poseTargets: THREE.Vector3[];
  positionBone: THREE.Bone; positionBind: THREE.Vector3;
  secondary: SecondaryMotion; source: ModelResource;
  height: number; nativeHeight: number; nativeMinY: number;
  turn: number; danceWeight: number; jumpWeight: number; hipsWeight: number;
  start: THREE.Vector3; target: THREE.Vector3;
}

function colorVector(value: number[]): THREE.Vector4 {
  return new THREE.Vector4(value[0] ?? 1, value[1] ?? 1, value[2] ?? 1, value[3] ?? 1);
}

/** Native skeletal actors rendered into the left stage; all projections use CSS pixels. */
export class Stage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-3, 3, 2.55, -2.55, 0.1, 40);
  private readonly actors: Actor[] = [];
  private readonly resources: ModelResource[] = [];
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly textureLoads = new Map<string, Promise<THREE.Texture>>();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  private readonly black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  private readonly hiddenMaterial = new THREE.ShaderMaterial({ visible: false });
  private readonly projection: StageProjection = { actors: [], slots: [], groundY: 0, rangeLeft: 0, rangeRight: 0 };
  private readonly v = Array.from({ length: 15 }, () => new THREE.Vector3());
  private readonly q = Array.from({ length: 9 }, () => new THREE.Quaternion());
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private elementCount = 0;
  private revision = -1;
  private physics = true;
  private disposed = false;
  private loaded = false;
  private width = 1;
  private height = 1;
  private pixelRatio = 0;
  private focusSize = 2.55;
  private focusX = 0;
  private size = 2.55;
  private cameraX = 0;
  private focusLo = 0;
  private focusHi = 5;
  private lastFrame = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.camera.position.set(0, 1.13, 10);
    this.white.needsUpdate = this.black.needsUpdate = true;
  }

  async load(progress?: (message: string) => void): Promise<void> {
    if (this.loaded) return;
    progress?.('加载原版角色与骨骼动画…');
    const resources = await Promise.all([1062, 1003].map(async id => {
      const response = await fetch(`/models/mini-${id}.json`);
      if (!response.ok) throw new Error(`Mini ${id} could not load (${response.status})`);
      const asset = await response.json() as RigAsset;
      const paths = new Set(asset.materials.flatMap(material => [material.texture, material.emissive].filter((path): path is string => Boolean(path))));
      progress?.(`加载 ${asset.id} 的原版贴图…`);
      await Promise.all(Array.from(paths, path => this.loadTexture(path)));
      if (this.disposed) return null;
      return this.createResource(asset);
    }));
    if (this.disposed) return;
    for (const resource of resources) if (resource) this.resources.push(resource);
    progress?.('准备原版角色动画…');
    for (let value = 1; value <= 12; value++) {
      const resource = this.resources.find(resource => resource.asset.id === (value % 2 === 1 ? 1062 : 1003));
      if (!resource) throw new Error(`Missing original model for value ${value}`);
      const actor = this.createActor(value, resource);
      this.actors.push(actor);
      this.scene.add(actor.root);
      actor.root.visible = false;
    }
    this.loaded = true;
  }

  private async loadTexture(path: string): Promise<THREE.Texture> {
    const pending = this.textureLoads.get(path);
    if (pending) return pending;
    const loading = this.textureLoader.loadAsync(path).then(texture => {
      if (this.disposed) { texture.dispose(); throw new Error('Stage disposed while loading textures'); }
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
      this.textures.set(path, texture);
      return texture;
    });
    this.textureLoads.set(path, loading);
    return loading;
  }

  private createMaterial(source: RigMaterial, outline = false): THREE.ShaderMaterial {
    const body = source.shader.endsWith('/MiniCharaBody');
    const multiply = source.shader.endsWith('/UnlitMultiply');
    const uv = source.uv;
    const outlineColor = colorVector(source.outlineColor);
    const material = new THREE.ShaderMaterial({
      name: source.name + (outline ? '_Outline' : ''), vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        diffuseMap: { value: source.texture ? this.textures.get(source.texture) : this.white },
        emissiveMap: { value: source.emissive ? this.textures.get(source.emissive) : this.black },
        charaColor: { value: colorVector(source.color) }, emissiveColor: { value: colorVector(source.emissiveColor) },
        outlineColor: { value: new THREE.Vector3(outlineColor.x, outlineColor.y, outlineColor.z) },
        saturation: { value: source.saturation }, bodyMaterial: { value: body }, outlinePass: { value: outline },
        outlineWidth: { value: outline ? source.outlineWidth * 0.001 : 0 },
        uvTransform: { value: new THREE.Vector4(uv[0] ?? 1, uv[1] ?? 1, uv[2] ?? 0, uv[3] ?? 0) },
        expressionOffset: { value: new THREE.Vector2() },
      },
      side: outline ? THREE.BackSide : THREE.FrontSide,
      depthTest: true, depthWrite: true, transparent: multiply,
      toneMapped: false,
    });
    // The Unity 'ZIgnoreTransparent' port is actually opaque and ZWrite On;
    // only the multiply overlay blends (DstColor Zero), also retaining depth writes.
    if (multiply) {
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.AddEquation;
      material.blendSrc = THREE.DstColorFactor;
      material.blendDst = THREE.ZeroFactor;
      material.blendEquationAlpha = THREE.AddEquation;
      material.blendSrcAlpha = THREE.DstAlphaFactor;
      material.blendDstAlpha = THREE.ZeroFactor;
    } else {
      material.blending = THREE.NoBlending;
      material.stencilWrite = source.stencilComp !== 0;
      material.stencilRef = source.stencilRef;
      material.stencilFunc = STENCIL_FUNCTIONS[source.stencilComp] ?? THREE.AlwaysStencilFunc;
      material.stencilFail = material.stencilZFail = THREE.KeepStencilOp;
      material.stencilZPass = STENCIL_OPERATIONS[source.stencilOp] ?? THREE.KeepStencilOp;
    }
    return material;
  }

  private createResource(asset: RigAsset): ModelResource {
    const materials = asset.materials.map(material => this.createMaterial(material));
    const outlines = asset.materials.map(material => material.shader.endsWith('/MiniCharaBody') ? this.createMaterial(material, true) : this.hiddenMaterial);
    const meshes = asset.meshes.map(source => {
      const geometry = new THREE.BufferGeometry();
      geometry.name = source.name;
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(source.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(source.uv, 2));
      if (source.bones.length > 0) {
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(source.joints, 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(source.weights, 4));
      }
      geometry.setIndex(source.indices);
      for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
      return { source, geometry, inverses: null, bind: null };
    });
    const clips = {} as ModelResource['clips'];
    for (const source of asset.clips) {
      const tracks = source.tracks.map(track => {
        const path = `n${track.node}.${track.property}`;
        return track.property === 'quaternion'
          ? new THREE.QuaternionKeyframeTrack(path, track.times, track.values)
          : new THREE.VectorKeyframeTrack(path, track.times, track.values);
      });
      clips[source.name] = new THREE.AnimationClip(source.name, source.duration, tracks);
    }
    for (const name of ['idle', 'dance', 'jump'] as const) {
      if (!clips[name] || clips[name].duration <= 0 || clips[name].tracks.length === 0) throw new Error(`Mini ${asset.id}: missing original ${name} clip`);
    }
    const roots = asset.nodes.flatMap((node, index) => node.parent < 0 ? [index] : []);
    return { asset, materials, outlines, meshes, clips, bounds: null, roots };
  }

  private createActor(value: number, source: ModelResource): Actor {
    const root = new THREE.Group();
    root.name = `Value_${value}`;
    const model = new THREE.Group();
    model.name = `Mini_${source.asset.id}`;
    root.add(model);
    const nodes = source.asset.nodes.map((node, index) => {
      const bone = new THREE.Bone();
      // Original rigs contain duplicate Head/Hip names. Index binding is unambiguous
      // and lets every actor share the immutable animation clips.
      bone.name = `n${index}`;
      bone.position.fromArray(node.position);
      bone.quaternion.fromArray(node.rotation);
      bone.scale.fromArray(node.scale);
      return bone;
    });
    source.asset.nodes.forEach((node, index) => (node.parent < 0 ? model : nodes[node.parent]).add(nodes[index]));
    model.updateWorldMatrix(true, true);
    const facial = new Set(source.asset.meshes.filter(mesh => mesh.name === 'M_Eye' || mesh.name === 'M_Mouth').flatMap(mesh => mesh.materials));
    const ownMaterials: THREE.ShaderMaterial[] = [];
    const materials = source.materials.map((material, index) => {
      if (!facial.has(index)) return material;
      const independent = material.clone();
      ownMaterials.push(independent);
      return independent;
    });
    const skeletons: THREE.Skeleton[] = [];
    let eyes: THREE.ShaderMaterial | undefined;
    let mouth: THREE.ShaderMaterial | undefined;
    for (const resource of source.meshes) {
      const data = resource.source;
      const meshMaterials = data.materials.map(index => materials[index]);
      const mesh = data.bones.length > 0
        ? new THREE.SkinnedMesh(resource.geometry, meshMaterials)
        : new THREE.Mesh(resource.geometry, meshMaterials);
      mesh.name = data.name;
      mesh.frustumCulled = false;
      mesh.renderOrder = Math.min(...data.materials.map(index => source.asset.materials[index].queue));
      nodes[data.node].add(mesh);
      mesh.updateWorldMatrix(true, false);
      let skeleton: THREE.Skeleton | null = null;
      if (mesh instanceof THREE.SkinnedMesh) {
        if (!resource.bind || !resource.inverses) {
          resource.bind = mesh.matrixWorld.clone();
          const inverseMeshWorld = resource.bind.clone().invert();
          // Exported bindpose = inverse(boneWorld) * meshWorld. Three expects
          // inverse(boneWorld); Matrix4.fromArray consumes Unity column-major data.
          resource.inverses = data.bindposes.map(bindpose => new THREE.Matrix4().fromArray(bindpose).multiply(inverseMeshWorld));
        }
        skeleton = new THREE.Skeleton(data.bones.map(index => nodes[index]), resource.inverses);
        mesh.bind(skeleton, resource.bind);
        skeletons.push(skeleton);
      }
      if (data.name === 'M_Eye') eyes = meshMaterials[0];
      if (data.name === 'M_Mouth') mouth = meshMaterials[0];
      const outlineMaterials = data.materials.map(index => source.outlines[index]);
      if (outlineMaterials.some(material => material !== this.hiddenMaterial)) {
        const outline = skeleton
          ? new THREE.SkinnedMesh(resource.geometry, outlineMaterials)
          : new THREE.Mesh(resource.geometry, outlineMaterials);
        outline.name = `${data.name}_Outline`;
        outline.frustumCulled = false;
        outline.renderOrder = mesh.renderOrder - 0.5;
        nodes[data.node].add(outline);
        if (outline instanceof THREE.SkinnedMesh && skeleton && resource.bind) outline.bind(skeleton, resource.bind);
      }
    }
    if (!eyes || !mouth) throw new Error(`Mini ${source.asset.id}: missing original eye/mouth materials`);
    const mixer = new THREE.AnimationMixer(model);
    const actions = {} as Actor['actions'];
    for (const name of ['idle', 'dance', 'jump'] as const) {
      const action = mixer.clipAction(source.clips[name]);
      action.play();
      action.paused = true;
      action.setEffectiveWeight(name === 'idle' ? 1 : 0);
      actions[name] = action;
    }
    const findPath = (path: string): THREE.Bone => {
      let parent = source.asset.nodes.findIndex(node => node.parent < 0);
      for (const part of path.split('/')) {
        const next = source.asset.nodes.findIndex(node => node.parent === parent && node.name === part);
        if (next < 0) throw new Error(`Mini ${source.asset.id}: missing original pose bone ${path}`);
        parent = next;
      }
      return nodes[parent];
    };
    const poseBones = POSE_PATHS.map(findPath);
    const bindRotations = poseBones.map(bone => bone.quaternion.clone());
    const positionBone = findPath('Position');
    const positionBind = positionBone.position.clone();
    mixer.update(0);
    positionBone.position.copy(positionBind);
    model.updateWorldMatrix(true, true);
    if (!source.bounds) {
      source.bounds = new THREE.Box3();
      const corner = new THREE.Vector3();
      for (const resource of source.meshes) {
        const data = resource.source as BoundRigMesh;
        if (data.bones.length === 0) {
          resource.geometry.computeBoundingBox();
          if (resource.geometry.boundingBox) source.bounds.union(resource.geometry.boundingBox.clone().applyMatrix4(nodes[data.node].matrixWorld));
          continue;
        }
        if (!data.bounds || !nodes[data.rootBone]) throw new Error(`Mini ${source.asset.id}: missing original renderer bounds for ${data.name}`);
        for (let bits = 0; bits < 8; bits++) {
          corner.set(
            data.bounds.center[0] + data.bounds.extents[0] * ((bits & 1) ? 1 : -1),
            data.bounds.center[1] + data.bounds.extents[1] * ((bits & 2) ? 1 : -1),
            data.bounds.center[2] + data.bounds.extents[2] * ((bits & 4) ? 1 : -1),
          ).applyMatrix4(nodes[data.rootBone].matrixWorld);
          source.bounds.expandByPoint(corner);
        }
      }
    }
    const nativeHeight = source.bounds.max.y - source.bounds.min.y;
    if (!(nativeHeight > 0)) throw new Error(`Mini ${source.asset.id}: invalid original renderer height`);
    return {
      value, root, model, nodes, skeletons, mixer, actions, ownMaterials, eyes, mouth, poseBones, bindRotations,
      nativeRotations: poseBones.map(bone => bone.quaternion.clone()),
      poseOffsets: poseBones.map(() => new THREE.Quaternion()), poseTargets: poseBones.map(() => new THREE.Vector3()),
      positionBone, positionBind, source, secondary: new SecondaryMotion(model, nodes, source.asset),
      height: 1, nativeHeight, nativeMinY: source.bounds.min.y,
      turn: 0, danceWeight: 0, jumpWeight: 0, hipsWeight: 0,
      start: new THREE.Vector3(), target: new THREE.Vector3(),
    };
  }

  setPhysics(enabled: boolean): void { this.physics = enabled; }

  private slotX(slot: number): number { return -2.5 + slot * 5 / (this.elementCount - 1); }

  private configure(count: number): void {
    this.elementCount = count;
    this.focusLo = 0;
    this.focusHi = count - 1;
    this.projection.actors.length = count;
    this.projection.slots.length = count;
    for (const actor of this.actors) {
      actor.secondary.prepare();
      actor.mixer.stopAllAction();
      actor.root.visible = actor.value <= count;
      if (!actor.root.visible) continue;
      actor.height = 0.64 + 0.96 * actor.value / count;
      const scale = actor.height / actor.nativeHeight;
      actor.model.scale.setScalar(scale);
      actor.model.position.set(0, -actor.nativeMinY * scale, 0);
      actor.model.rotation.set(0, Math.PI, 0);
      actor.turn = actor.danceWeight = actor.jumpWeight = actor.hipsWeight = 0;
      actor.poseBones.forEach((bone, index) => {
        bone.quaternion.copy(actor.bindRotations[index]);
        actor.nativeRotations[index].copy(actor.bindRotations[index]);
        actor.poseOffsets[index].identity();
      });
      actor.positionBone.position.copy(actor.positionBind);
      for (const name of ['idle', 'dance', 'jump'] as const) {
        actor.actions[name].reset().play();
        actor.actions[name].paused = true;
      }
      actor.actions.idle.setEffectiveWeight(1);
      actor.actions.dance.setEffectiveWeight(0);
      actor.actions.jump.setEffectiveWeight(0);
      actor.actions.jump.time = 0;
      this.projection.actors[actor.value - 1] ??= { value: actor.value, x: 0, y: 0, groundX: 0, groundY: 0, shadowWidth: 0, lift: 0 };
    }
  }

  update(state: PlaybackState): StageProjection {
    if (this.disposed || !this.loaded) return this.projection;
    const now = performance.now();
    const wallDelta = this.lastFrame ? clamp((now - this.lastFrame) / 1000, 0, 0.1) : 0;
    this.lastFrame = now;
    this.resize();
    const countChanged = this.elementCount !== state.elementCount;
    if (countChanged) this.configure(state.elementCount);
    const changed = this.revision !== state.revision;
    const resetPhysics = countChanged || (changed && !state.animating);
    if (changed || countChanged) {
      for (let slot = 0; slot < this.elementCount; slot++) {
        const actor = this.actors[state.step.values[slot] - 1];
        actor.start.copy(actor.root.position);
        actor.target.set(this.slotX(slot), 0, 0);
        if (!state.animating || countChanged) actor.root.position.copy(actor.target);
      }
      this.revision = state.revision;
    }
    this.applyFocus(state, wallDelta, changed && !state.animating);
    const eased = state.transition * state.transition * (3 - 2 * state.transition);
    const arc = Math.sin(state.transition * Math.PI);
    for (let slot = 0; slot < this.elementCount; slot++) {
      const actor = this.actors[state.step.values[slot] - 1];
      actor.root.position.copy(actor.target);
      if (state.animating) {
        actor.root.position.lerpVectors(actor.start, actor.target, eased);
        if (slot === state.step.swapA || slot === state.step.swapB) {
          const high = slot === state.step.swapA;
          actor.root.position.y += arc * (high ? 0.95 : 0.65);
          actor.root.position.z += arc * (high ? 0.3 : -0.3);
        }
      }
      this.sampleMotion(actor, slot, state);
      this.applyPerformance(actor, slot, state);
      actor.secondary.enabled = this.physics;
      actor.secondary.simulate(state.delta, resetPhysics);
    }
    this.renderer.render(this.scene, this.camera);
    this.project(state);
    return this.projection;
  }

  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (width === this.width && height === this.height && ratio === this.pixelRatio) return;
    this.width = width;
    this.height = height;
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
  }

  private applyFocus(state: PlaybackState, wallDelta: number, instant: boolean): void {
    const step = state.step;
    if (step.hi > step.lo) { this.focusLo = step.lo; this.focusHi = step.hi; }
    const lo = clamp(this.focusLo, 0, this.elementCount - 1);
    const hi = clamp(this.focusHi, lo, this.elementCount - 1);
    const range = hi - lo + 1;
    const aspect = this.width / this.height;
    const fullSize = Math.max(2.55, 2.55 * (1216 / 1020) / aspect);
    const base = range === 2 ? 1.35 : 1.85;
    const rangeWidth = this.slotX(hi) - this.slotX(lo);
    this.focusSize = step.kind === 'complete' || range > 3 ? fullSize : Math.min(fullSize, Math.max(base, (rangeWidth + 1.6) / (2 * aspect)));
    this.focusX = this.focusSize >= fullSize ? 0 : (this.slotX(lo) + this.slotX(hi)) * 0.5;
    const blend = instant ? 1 : 1 - Math.exp(-wallDelta * 8);
    this.size = THREE.MathUtils.lerp(this.size, this.focusSize, blend);
    this.cameraX = THREE.MathUtils.lerp(this.cameraX, this.focusX, blend);
    const fullBlend = clamp((this.size - 1.35) / (fullSize - 1.35), 0, 1);
    const groundFraction = THREE.MathUtils.lerp((600 - 210) / 510, (578 - 210) / 510, fullBlend);
    this.camera.position.set(this.cameraX, this.size * (2 * groundFraction - 1), 10);
    this.camera.left = -this.size * aspect;
    this.camera.right = this.size * aspect;
    this.camera.top = this.size;
    this.camera.bottom = -this.size;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  private sampleMotion(actor: Actor, slot: number, state: PlaybackState): void {
    actor.secondary.prepare();
    // PropertyMixer skips equal samples. Restore the previous native pose before
    // evaluating a frozen frame so procedural rotations cannot accumulate.
    for (let index = 0; index < actor.poseBones.length; index++) actor.poseBones[index].quaternion.copy(actor.nativeRotations[index]);
    const jumping = state.animating && state.step.kind === 'swap' && (slot === state.step.swapA || slot === state.step.swapB);
    const ending = clamp((state.celebrationTime - 4.2) / 0.8, 0, 1);
    const danceTarget = state.step.kind === 'complete' ? 1 - ending * ending * (3 - 2 * ending) : 0;
    const blend = 1 - Math.exp(-state.delta / 0.16);
    actor.danceWeight = THREE.MathUtils.lerp(actor.danceWeight, danceTarget, blend);
    actor.jumpWeight = THREE.MathUtils.lerp(actor.jumpWeight, jumping ? 1 : 0, blend);
    const danceWeight = actor.danceWeight * (1 - actor.jumpWeight);
    actor.actions.idle.setEffectiveWeight(1 - actor.jumpWeight - danceWeight);
    actor.actions.dance.setEffectiveWeight(danceWeight);
    actor.actions.jump.setEffectiveWeight(actor.jumpWeight);
    actor.actions.idle.time = (state.idleTime + actor.value * 0.41) % actor.source.clips.idle.duration;
    actor.actions.dance.time = (state.idleTime + actor.value * 0.055) % actor.source.clips.dance.duration;
    if (jumping) actor.actions.jump.time = state.transition * actor.source.clips.jump.duration;
    actor.mixer.update(0);
    for (let index = 0; index < actor.poseBones.length; index++) actor.nativeRotations[index].copy(actor.poseBones[index].quaternion);
    actor.positionBone.position.copy(actor.positionBind);
    // Root motion is not applied, matching the manual native playable graph.
    for (const index of actor.source.roots) {
      const node = actor.source.asset.nodes[index];
      actor.nodes[index].position.fromArray(node.position);
      actor.nodes[index].quaternion.fromArray(node.rotation);
      actor.nodes[index].scale.fromArray(node.scale);
    }
  }

  private applyPerformance(actor: Actor, slot: number, state: PlaybackState): void {
    const step = state.step;
    const pivot = (state.algorithm === 'quick' || state.algorithm === 'selection') && slot === step.pivotIndex && step.pivotIndex >= 0 && step.kind !== 'complete' && step.kind !== 'rangeComplete';
    const swapping = step.kind === 'swap' && (slot === step.swapA || slot === step.swapB);
    const comparing = step.kind === 'compare' || step.kind === 'advance';
    let eyes = 0, mouth = 0, turn = 0;
    for (const target of actor.poseTargets) target.set(0, 0, 0);
    if (step.kind === 'complete') { eyes = 9; mouth = 2; }
    else if (swapping) {
      eyes = state.animating ? 13 : 8;
      mouth = state.animating || actor.value % 2 === 1 ? 2 : 8;
      if (!state.animating) {
        const settle = state.landing / 0.55;
        actor.poseTargets[NECK].set(8 * settle, 0, 0);
        actor.poseTargets[CHEST].set(6 * settle, 0, 0);
      }
    } else {
      if (pivot) {
        eyes = mouth = 8;
        actor.poseTargets[NECK].set(0, 0, Math.sin(state.idleTime * 1.7 + actor.value * 0.4) * 3);
      } else if ((state.idleTime + actor.value * 0.67) % 3.7 < 0.14) eyes = 8;
      if (comparing && step.j >= 0) {
        const targetValue = step.values[step.j];
        if (actor.value !== targetValue) {
          const other = this.actors[targetValue - 1];
          const distance = other.target.x - actor.target.x;
          turn = -Math.sign(distance) * THREE.MathUtils.lerp(18, 58, clamp(Math.abs(distance) / 5, 0, 1));
          actor.poseTargets[NECK].set((actor.height - other.height) * 12, turn * 0.16, Math.sin(state.idleTime * 2.1 + actor.value * 0.65) * 2.5);
        } else {
          mouth = 1;
          actor.poseTargets[CHEST].set(5, 0, 0);
          actor.poseTargets[NECK].set(13 + Math.sin(state.idleTime * 2) * 2, 0, 0);
          actor.poseTargets[LEFT_ARM].set(-55, 12, -8);
          actor.poseTargets[RIGHT_ARM].set(-55, -12, 8);
          actor.poseTargets[LEFT_ELBOW].set(-20, 0, 0);
          actor.poseTargets[RIGHT_ELBOW].set(-20, 0, 0);
          actor.poseTargets[LEFT_WRIST].set(8, 0, -8);
          actor.poseTargets[RIGHT_WRIST].set(8, 0, 8);
        }
      }
    }
    const blend = 1 - Math.exp(-state.delta / 0.18);
    actor.turn = THREE.MathUtils.lerp(actor.turn, turn, blend);
    actor.model.rotation.set(0, Math.PI - radians(actor.turn), 0);
    actor.model.updateWorldMatrix(true, true);
    for (let index = actor.poseBones.length - 1; index >= 0; index--) {
      const target = actor.poseTargets[index];
      // Unity Quaternion.Euler is Z-X-Y; conjugating by the handedness flip
      // negates quaternion X/Y while retaining Z/W.
      this.euler.set(radians(target.x), radians(target.y), radians(target.z), 'YXZ');
      const rotation = this.q[0].setFromEuler(this.euler);
      rotation.x = -rotation.x;
      rotation.y = -rotation.y;
      actor.poseOffsets[index].slerp(rotation, blend);
      this.rotatePose(actor, actor.poseBones[index], actor.poseOffsets[index]);
    }
    actor.hipsWeight = THREE.MathUtils.lerp(actor.hipsWeight, pivot && !swapping && step.kind !== 'complete' ? 1 : 0, blend);
    this.placeHandOnHip(actor, LEFT_ARM, LEFT_ELBOW, LEFT_WRIST);
    this.placeHandOnHip(actor, RIGHT_ARM, RIGHT_ELBOW, RIGHT_WRIST);
    (actor.eyes.uniforms.expressionOffset.value as THREE.Vector2).set(0.25 * (eyes % 4), -0.125 * Math.floor(eyes / 4));
    (actor.mouth.uniforms.expressionOffset.value as THREE.Vector2).set(0.25 * (mouth % 4), -0.125 * Math.floor(mouth / 4));
  }

  private setWorldQuaternion(bone: THREE.Object3D, rotation: THREE.Quaternion): void {
    if (bone.parent) {
      const inverseParent = bone.parent.getWorldQuaternion(this.q[8]).invert();
      bone.quaternion.copy(inverseParent).multiply(rotation);
    } else bone.quaternion.copy(rotation);
    bone.updateWorldMatrix(false, true);
  }

  private rotatePose(actor: Actor, bone: THREE.Bone, offset: THREE.Quaternion): void {
    const frame = actor.model.getWorldQuaternion(this.q[1]);
    const inverse = this.q[2].copy(frame).invert();
    const current = bone.getWorldQuaternion(this.q[3]);
    const rotation = this.q[4].copy(frame).multiply(offset).multiply(inverse).multiply(current);
    this.setWorldQuaternion(bone, rotation);
  }

  private placeHandOnHip(actor: Actor, armIndex: number, elbowIndex: number, wristIndex: number): void {
    if (actor.hipsWeight < 0.0001) return;
    const arm = actor.poseBones[armIndex], elbow = actor.poseBones[elbowIndex], wrist = actor.poseBones[wristIndex];
    const shoulder = actor.model.worldToLocal(arm.getWorldPosition(this.v[0]));
    const middle = actor.model.worldToLocal(elbow.getWorldPosition(this.v[1]));
    const hand = actor.model.worldToLocal(wrist.getWorldPosition(this.v[2]));
    const chest = actor.model.worldToLocal(actor.poseBones[CHEST].getWorldPosition(this.v[3]));
    const side = Math.sign(shoulder.x);
    const goal = this.v[4].set(side * Math.abs(shoulder.x) * 0.82, chest.y - 0.11, chest.z - 0.025);
    const upper = shoulder.distanceTo(middle), lower = middle.distanceTo(hand);
    const direction = this.v[5].subVectors(goal, shoulder).normalize();
    const distance = clamp(goal.distanceTo(shoulder), Math.abs(upper - lower) + 0.001, upper + lower - 0.001);
    goal.copy(shoulder).addScaledVector(direction, distance);
    const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
    const outward = this.v[6].set(side, 0, 0.25).addScaledVector(direction, -this.v[6].dot(direction)).normalize();
    const elbowGoal = this.v[7].copy(shoulder).addScaledVector(direction, along).addScaledVector(outward, Math.sqrt(Math.max(0, upper * upper - along * along)));
    const rotation = actor.model.getWorldQuaternion(this.q[0]);
    const from = this.v[8].subVectors(middle, shoulder).applyQuaternion(rotation).normalize();
    const to = this.v[9].subVectors(elbowGoal, shoulder).applyQuaternion(rotation).normalize();
    const armDelta = this.q[1].setFromUnitVectors(from, to);
    const armWorld = arm.getWorldQuaternion(this.q[2]);
    const armGoal = this.q[3].copy(armDelta).multiply(armWorld);
    armWorld.slerp(armGoal, actor.hipsWeight);
    this.setWorldQuaternion(arm, armWorld);
    const elbowWorldPosition = elbow.getWorldPosition(this.v[10]);
    from.subVectors(wrist.getWorldPosition(this.v[11]), elbowWorldPosition).normalize();
    to.copy(goal);
    actor.model.localToWorld(to);
    to.sub(elbowWorldPosition).normalize();
    const elbowDelta = this.q[1].setFromUnitVectors(from, to);
    const elbowWorld = elbow.getWorldQuaternion(this.q[2]);
    const elbowGoalRotation = this.q[3].copy(elbowDelta).multiply(elbowWorld);
    elbowWorld.slerp(elbowGoalRotation, actor.hipsWeight);
    this.setWorldQuaternion(elbow, elbowWorld);
  }

  private project(state: PlaybackState): void {
    const pixelScale = this.height / (2 * this.size);
    const spacing = 5 / (this.elementCount - 1);
    const projected = this.v[0].set(0, 0, 0).project(this.camera);
    this.projection.groundY = (1 - projected.y) * this.height * 0.5;
    for (let slot = 0; slot < this.elementCount; slot++) {
      projected.set(this.slotX(slot), 0, 0).project(this.camera);
      this.projection.slots[slot] = (projected.x + 1) * this.width * 0.5;
    }
    for (let value = 1; value <= this.elementCount; value++) {
      const actor = this.actors[value - 1];
      const label: ActorProjection = this.projection.actors[value - 1];
      projected.copy(actor.root.position);
      projected.y += actor.height + 0.22;
      projected.project(this.camera);
      label.x = (projected.x + 1) * this.width * 0.5;
      label.y = (1 - projected.y) * this.height * 0.5;
      projected.set(actor.root.position.x, 0, 0).project(this.camera);
      label.groundX = (projected.x + 1) * this.width * 0.5;
      label.groundY = this.projection.groundY;
      label.shadowWidth = Math.min(actor.height * 0.45 + 0.3, spacing * 1.02) * pixelScale;
      label.lift = actor.root.position.y;
    }
    const padding = Math.min(1, spacing) * this.height * 43 / 510;
    this.projection.rangeLeft = this.projection.slots[clamp(state.step.lo, 0, this.elementCount - 1)] - padding;
    this.projection.rangeRight = this.projection.slots[clamp(state.step.hi, 0, this.elementCount - 1)] + padding;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const actor of this.actors) {
      actor.secondary.dispose();
      actor.mixer.stopAllAction();
      actor.mixer.uncacheRoot(actor.model);
      for (const skeleton of actor.skeletons) skeleton.dispose();
      for (const material of actor.ownMaterials) material.dispose();
    }
    for (const resource of this.resources) {
      for (const mesh of resource.meshes) mesh.geometry.dispose();
      for (const material of resource.materials) material.dispose();
      for (const material of resource.outlines) if (material !== this.hiddenMaterial) material.dispose();
    }
    for (const texture of this.textures.values()) texture.dispose();
    this.white.dispose();
    this.black.dispose();
    this.hiddenMaterial.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.actors.length = this.resources.length = 0;
    this.textures.clear();
    this.textureLoads.clear();
  }
}
