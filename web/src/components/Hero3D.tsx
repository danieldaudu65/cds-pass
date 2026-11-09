import { Float, RoundedBox } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

/** Draws the front of the floating tag onto a texture (no font downloads needed). */
function useTagTexture() {
  return useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 740;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 512, 740);
    grad.addColorStop(0, '#0E7F46');
    grad.addColorStop(1, '#064726');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 740);

    g.fillStyle = 'rgba(255,255,255,0.08)';
    for (let x = 12; x < 512; x += 24) for (let y = 12; y < 740; y += 24) g.fillRect(x, y, 2, 2);

    g.fillStyle = '#FFFFFF';
    g.font = '800 34px "Plus Jakarta Sans", system-ui, sans-serif';
    g.fillText('CDS PASS', 40, 70);

    g.fillStyle = '#E3F2E8';
    g.beginPath();
    g.arc(90, 165, 46, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(156, 140, 220, 22);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(156, 176, 150, 16);

    g.fillStyle = '#CFE6D6';
    g.font = '700 22px "Plus Jakarta Sans", system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('YOUR NUMBER', 256, 300);
    g.fillStyle = '#FFFFFF';
    g.font = '800 230px "Plus Jakarta Sans", system-ui, sans-serif';
    g.fillText('14', 256, 500);

    g.fillStyle = '#FFFFFF';
    g.beginPath();
    if (typeof g.roundRect === 'function') g.roundRect(40, 590, 432, 90, 26);
    else g.rect(40, 590, 432, 90);
    g.fill();
    g.fillStyle = '#0B6B3A';
    g.font = '800 30px "Plus Jakarta Sans", system-ui, sans-serif';
    g.fillText("IT'S YOUR TURN ✓", 256, 647);

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, []);
}

function Tag() {
  const ref = useRef<THREE.Group>(null);
  const tex = useTagTexture();
  useFrame((s) => {
    if (!ref.current) return;
    const t = s.clock.elapsedTime;
    ref.current.rotation.y = Math.sin(t * 0.6) * 0.45 + s.pointer.x * 0.25;
    ref.current.rotation.x = Math.sin(t * 0.4) * 0.08 - s.pointer.y * 0.15;
  });
  return (
    <group ref={ref}>
      <RoundedBox args={[2.2, 3.18, 0.14]} radius={0.12} smoothness={5}>
        <meshStandardMaterial color="#064726" metalness={0.25} roughness={0.4} />
      </RoundedBox>
      <mesh position={[0, 0, 0.0715]}>
        <planeGeometry args={[2.06, 2.98]} />
        <meshStandardMaterial map={tex} roughness={0.45} metalness={0.05} />
      </mesh>
      {/* lanyard clip */}
      <mesh position={[0, 1.75, 0]}>
        <torusGeometry args={[0.16, 0.05, 16, 40]} />
        <meshStandardMaterial color="#C9B783" metalness={0.8} roughness={0.25} />
      </mesh>
    </group>
  );
}

function Orb({ position, color, size }: { position: [number, number, number]; color: string; size: number }) {
  return (
    <Float speed={2} rotationIntensity={0.6} floatIntensity={1.4}>
      <mesh position={position}>
        <icosahedronGeometry args={[size, 1]} />
        <meshStandardMaterial color={color} roughness={0.3} metalness={0.2} flatShading />
      </mesh>
    </Float>
  );
}

export default function Hero3D() {
  return (
    <Canvas dpr={[1, 1.6]} camera={{ position: [0, 0, 6.2], fov: 42 }} gl={{ antialias: true, alpha: true }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 4, 5]} intensity={1.6} />
      <pointLight position={[-4, -2, 3]} intensity={18} color="#C9B783" />
      <Float speed={1.4} rotationIntensity={0.2} floatIntensity={0.6}>
        <Tag />
      </Float>
      <Orb position={[-1.9, 1.3, -0.6]} color="#E3F2E8" size={0.28} />
      <Orb position={[1.9, -1.2, -0.4]} color="#C9B783" size={0.22} />
      <Orb position={[1.7, 1.6, -1.2]} color="#0E7F46" size={0.34} />
      <Orb position={[-1.6, -1.7, -0.9]} color="#FFFFFF" size={0.18} />
    </Canvas>
  );
}
