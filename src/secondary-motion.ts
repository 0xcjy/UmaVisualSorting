import * as THREE from 'three';
import type { RigAsset, RigMesh } from './contracts';

/** Serialized renderer bounds are in the renderer's root-bone frame, not mesh space. */
export type BoundRigMesh = RigMesh & { rootBone: number; bounds: { center: number[]; extents: number[] } };
type Kind = 'hair' | 'ear' | 'tail';
interface Spring {
  bone: THREE.Object3D; tip: THREE.Object3D; kind: Kind;
  stiffness: number; damping: number; maxAngle: number;
  localTip: THREE.Vector3; nativeRotation: THREE.Quaternion; offset: THREE.Quaternion;
  nativeOrigin: THREE.Vector3; nativeTip: THREE.Vector3;
  position: THREE.Vector3; velocity: THREE.Vector3;
}
const HAIR_ROOTS = ['Sp_He_Hair0_C_00', 'Sp_He_Hair0_L_00', 'Sp_He_Hair1_L_00', 'Sp_He_Hair1_R_00', 'Sp_He_Hair2_L_00', 'Sp_He_Hair2_R_00', 'Sp_He_Hair4_C_00', 'Sp_He_Hair4_L_00', 'Sp_He_Hair4_R_00'];
const clamp = THREE.MathUtils.clamp;

/** Animation-relative spring tips; never takes ownership of primary or expression bones. */
export class SecondaryMotion {
  enabled = true;
  strength = 1;
  private readonly springs: Spring[] = [];
  private head: THREE.Object3D | null = null;
  private hip: THREE.Object3D | null = null;
  private chest: THREE.Object3D | null = null;
  private readonly headCenter = new THREE.Vector3();
  private readonly headRadii = new THREE.Vector3();
  private torsoRadius = 0;
  private readonly previousPosition = new THREE.Vector3();
  private readonly previousRotation = new THREE.Quaternion();
  private previousScale = 0;
  private readonly torsoStart = new THREE.Vector3();
  private readonly torsoEnd = new THREE.Vector3();
  private torsoWorldRadius = 0;
  private readonly headToWorld = new THREE.Matrix4();
  private readonly worldToHead = new THREE.Matrix4();
  private initialized = false;
  private applied = false;
  private disposed = false;
  // Independent scratch storage for nested collision helpers and integration.
  private readonly v = Array.from({ length: 21 }, () => new THREE.Vector3());
  private readonly q = Array.from({ length: 5 }, () => new THREE.Quaternion());

  constructor(private readonly model: THREE.Object3D, nodes: THREE.Object3D[], asset: RigAsset) {
    const hair = asset.meshes.find(mesh => mesh.name === 'M_Hair');
    const tail = asset.meshes.find(mesh => mesh.name === 'M_Tail');
    const face = asset.meshes.find(mesh => mesh.name === 'M_Face') as BoundRigMesh | undefined;
    const body = asset.meshes.find(mesh => mesh.name === 'M_Body') as BoundRigMesh | undefined;
    const find = (mesh: RigMesh, name: string): THREE.Object3D | null => {
      const index = mesh.bones.find(index => asset.nodes[index].name === name);
      return index === undefined ? null : nodes[index];
    };
    const addChain = (mesh: RigMesh, root: THREE.Object3D | null, kind: Kind, angle: number) => {
      if (!root) return;
      const bound = new Set(mesh.bones.map(index => nodes[index]));
      const name = asset.nodes[nodes.indexOf(root)].name;
      const prefix = name.slice(0, name.lastIndexOf('_') + 1);
      let depth = 0;
      for (let bone: THREE.Object3D | null = root; bone;) {
        const tip: THREE.Object3D | undefined = bone.children.find(child => bound.has(child) && asset.nodes[nodes.indexOf(child)]?.name.startsWith(prefix));
        if (!tip || tip.position.lengthSq() < 0.000001) break;
        this.springs.push({ bone, tip, kind,
          stiffness: kind === 'ear' ? 260 : kind === 'tail' ? 90 : 130,
          damping: kind === 'ear' ? 24 : kind === 'tail' ? 12 : 16,
          maxAngle: THREE.MathUtils.degToRad(angle) / (1 + depth * 0.5),
          localTip: tip.position.clone(), nativeRotation: bone.quaternion.clone(), offset: new THREE.Quaternion(),
          nativeOrigin: new THREE.Vector3(), nativeTip: new THREE.Vector3(), position: new THREE.Vector3(), velocity: new THREE.Vector3(),
        });
        bone = tip;
        depth++;
      }
    };
    if (hair) {
      for (const name of HAIR_ROOTS) {
        const root = find(hair, name);
        if (!root) continue;
        this.head = root.parent;
        addChain(hair, root, 'hair', name.startsWith('Sp_He_Hair4') ? 12 : 4);
      }
      addChain(hair, find(hair, 'Sp_He_Ear0_L_00'), 'ear', 7);
      addChain(hair, find(hair, 'Sp_He_Ear0_R_00'), 'ear', 7);
    }
    if (tail) {
      const root = find(tail, 'Sp_Hi_Tail0_B_00');
      if (root) this.hip = root.parent?.parent ?? null;
      addChain(tail, root, 'tail', 22);
    }
    this.chest = this.head?.parent?.parent ?? null;
    model.updateWorldMatrix(true, true);
    if (this.head && face) {
      if (!face.bounds || !nodes[face.rootBone]) throw new Error(`Mini ${asset.id}: missing original face root-bone bounds`);
      this.headCenter.fromArray(face.bounds.center);
      nodes[face.rootBone].localToWorld(this.headCenter);
      this.head.worldToLocal(this.headCenter);
      this.headRadii.fromArray(face.bounds.extents).multiplyScalar(0.82);
    }
    if (body) {
      if (!body.bounds) throw new Error(`Mini ${asset.id}: missing original body bounds`);
      this.torsoRadius = body.bounds.extents[0] * 0.36;
    }
  }

  prepare(): void {
    if (!this.applied || this.disposed) return;
    for (const spring of this.springs) spring.bone.quaternion.copy(spring.nativeRotation);
    this.applied = false;
  }

  simulate(dt: number, reset = false): void {
    if (this.disposed) return;
    this.model.updateWorldMatrix(true, true);
    for (const spring of this.springs) {
      spring.nativeRotation.copy(spring.bone.quaternion);
      spring.localTip.copy(spring.tip.position);
      spring.bone.getWorldPosition(spring.nativeOrigin);
      spring.nativeTip.copy(spring.localTip).applyMatrix4(spring.bone.matrixWorld);
    }
    const worldScale = this.v[0].setFromMatrixColumn(this.model.matrixWorld, 1).length();
    const weight = Number.isFinite(this.strength) ? clamp(this.strength, 0, 1) : 0;
    if (!this.enabled || weight === 0) { this.clearInertia(); return; }
    const position = this.model.getWorldPosition(this.v[0]);
    const rotation = this.model.getWorldQuaternion(this.q[0]);
    const teleport = Math.max(0.5, worldScale * 1.5);
    reset ||= !this.initialized || position.distanceToSquared(this.previousPosition) > teleport * teleport;
    reset ||= this.initialized && (rotation.angleTo(this.previousRotation) > THREE.MathUtils.degToRad(110) || Math.abs(worldScale - this.previousScale) > Math.max(0.001, this.previousScale * 0.15));
    this.previousPosition.copy(position);
    this.previousRotation.copy(rotation);
    this.previousScale = worldScale;
    if (this.hip && this.chest) {
      this.hip.getWorldPosition(this.torsoStart);
      this.chest.getWorldPosition(this.torsoEnd);
      this.torsoWorldRadius = this.torsoRadius * worldScale;
    }
    if (this.head) {
      this.headToWorld.copy(this.head.matrixWorld);
      this.worldToHead.copy(this.headToWorld).invert();
    }
    const elapsed = Number.isFinite(dt) ? clamp(dt, 0, 1 / 15) : 0;
    const substeps = elapsed > 0 ? Math.ceil(elapsed * 120) : 0;
    const step = substeps ? elapsed / substeps : 0;
    for (const spring of this.springs) {
      spring.bone.updateWorldMatrix(true, false);
      const anchor = spring.bone.getWorldPosition(this.v[0]);
      const target = this.v[1].copy(spring.localTip).applyMatrix4(spring.bone.matrixWorld);
      const direction = this.v[2].subVectors(target, anchor);
      const length = direction.length();
      if (length < 0.00001) continue;
      direction.multiplyScalar(1 / length);
      const nativeWorld = spring.bone.getWorldQuaternion(this.q[0]);
      if (reset) {
        spring.position.copy(target);
        spring.velocity.set(0, 0, 0);
        spring.offset.identity();
      } else if (substeps > 0) {
        const damping = Math.exp(-spring.damping * step);
        const gravity = -length * (spring.kind === 'ear' ? 0.35 : 1.8);
        for (let s = 0; s < substeps; s++) {
          spring.velocity.addScaledVector(this.v[3].subVectors(target, spring.position), spring.stiffness * step);
          spring.velocity.y += gravity * step;
          spring.velocity.multiplyScalar(damping);
          const candidate = this.v[4].copy(spring.position).addScaledVector(spring.velocity, step);
          this.constrain(candidate, anchor, direction, length, spring.maxAngle);
          this.exclude(spring, candidate, anchor);
          this.constrain(candidate, anchor, direction, length, spring.maxAngle);
          if (this.penetrates(spring, candidate, anchor)) candidate.copy(target);
          spring.velocity.subVectors(candidate, spring.position).multiplyScalar(1 / step).clampLength(0, length * 15);
          spring.position.copy(candidate);
        }
        const simulated = this.v[3].subVectors(spring.position, anchor).normalize();
        const delta = this.q[1].setFromUnitVectors(direction, simulated);
        spring.offset.copy(nativeWorld).invert().multiply(delta).multiply(nativeWorld);
      } else {
        this.v[3].copy(spring.localTip).normalize().applyQuaternion(spring.offset).applyQuaternion(nativeWorld);
        spring.position.copy(anchor).addScaledVector(this.v[3], length);
      }
      this.q[2].identity().slerp(spring.offset, weight);
      spring.bone.quaternion.copy(spring.nativeRotation).multiply(this.q[2]);
      spring.bone.updateWorldMatrix(false, true);
    }
    this.initialized = true;
    this.applied = true;
  }

  private constrain(point: THREE.Vector3, anchor: THREE.Vector3, rest: THREE.Vector3, length: number, angle: number): void {
    const direction = this.v[5].subVectors(point, anchor);
    if (direction.lengthSq() < 1e-8) direction.copy(rest); else direction.normalize();
    const delta = this.q[3].setFromUnitVectors(rest, direction);
    const actual = this.q[4].identity().angleTo(delta);
    if (actual > angle) delta.slerp(this.q[4], 1 - angle / actual);
    point.copy(rest).applyQuaternion(delta).multiplyScalar(length).add(anchor);
  }

  private exclude(spring: Spring, tip: THREE.Vector3, anchor: THREE.Vector3): void {
    for (let iteration = 0; iteration < 2; iteration++) {
      for (let sample = 1; sample <= 3; sample++) {
        const fraction = sample / 3;
        const point = this.v[6].lerpVectors(anchor, tip, fraction);
        const native = this.v[7].lerpVectors(spring.nativeOrigin, spring.nativeTip, fraction);
        const corrected = this.v[8].copy(point);
        if (spring.kind !== 'tail') this.excludeHead(corrected, native);
        if (spring.kind !== 'ear') this.excludeTorso(corrected, native);
        tip.addScaledVector(corrected.sub(point), 1 / fraction);
      }
    }
  }

  private penetrates(spring: Spring, tip: THREE.Vector3, anchor: THREE.Vector3): boolean {
    for (let sample = 1; sample <= 3; sample++) {
      const fraction = sample / 3;
      const point = this.v[6].lerpVectors(anchor, tip, fraction);
      const native = this.v[7].lerpVectors(spring.nativeOrigin, spring.nativeTip, fraction);
      const corrected = this.v[8].copy(point);
      if (spring.kind !== 'tail') {
        this.excludeHead(corrected, native);
        if (corrected.distanceToSquared(point) > 1e-8) return true;
      }
      corrected.copy(point);
      if (spring.kind !== 'ear') {
        this.excludeTorso(corrected, native);
        if (corrected.distanceToSquared(point) > 1e-8) return true;
      }
    }
    return false;
  }

  private excludeHead(point: THREE.Vector3, native: THREE.Vector3): void {
    if (!this.head || this.headRadii.x <= 0 || this.headRadii.y <= 0 || this.headRadii.z <= 0) return;
    const radial = this.v[9].copy(point).applyMatrix4(this.worldToHead).sub(this.headCenter).divide(this.headRadii);
    const reference = this.v[10].copy(native).applyMatrix4(this.worldToHead).sub(this.headCenter).divide(this.headRadii);
    const boundary = Math.min(1, reference.length());
    const distance = radial.length();
    if (distance >= boundary - 0.0001) return;
    if (distance > 0.00001) radial.multiplyScalar(1 / distance); else radial.copy(reference).normalize();
    point.copy(radial).multiplyScalar(boundary).multiply(this.headRadii).add(this.headCenter).applyMatrix4(this.headToWorld);
  }

  private excludeTorso(point: THREE.Vector3, native: THREE.Vector3): void {
    if (this.torsoWorldRadius <= 0) return;
    const center = this.closestOnTorso(point, this.v[11]);
    const referenceCenter = this.closestOnTorso(native, this.v[12]);
    const offset = this.v[13].subVectors(point, center);
    const reference = this.v[14].subVectors(native, referenceCenter);
    const boundary = Math.min(this.torsoWorldRadius, reference.length());
    const distance = offset.length();
    if (distance >= boundary - 0.00001) return;
    if (distance > 0.00001) offset.multiplyScalar(1 / distance); else offset.copy(reference).normalize();
    point.copy(center).addScaledVector(offset, boundary);
  }

  private closestOnTorso(point: THREE.Vector3, result: THREE.Vector3): THREE.Vector3 {
    const axis = this.v[15].subVectors(this.torsoEnd, this.torsoStart);
    const lengthSquared = axis.lengthSq();
    const t = lengthSquared > 1e-8 ? clamp(this.v[16].subVectors(point, this.torsoStart).dot(axis) / lengthSquared, 0, 1) : 0;
    return result.copy(this.torsoStart).addScaledVector(axis, t);
  }

  private clearInertia(): void {
    for (const spring of this.springs) { spring.velocity.set(0, 0, 0); spring.offset.identity(); }
    this.initialized = this.applied = false;
  }

  dispose(): void {
    this.prepare();
    this.clearInertia();
    this.disposed = true;
  }
}
