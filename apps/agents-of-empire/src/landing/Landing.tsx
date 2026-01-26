import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

interface LandingProps {
  onEnterGame?: () => void;
}

const Landing = ({ onEnterGame }: LandingProps) => {
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15,
        delayChildren: 0.2,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 30 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        type: 'spring',
        damping: 12,
        stiffness: 100,
      },
    },
  };

  const phases = [
    {
      title: 'MVP',
      duration: '8 Weeks',
      status: 'active',
      features: [
        '3D world with agent placement',
        'Agent integration & event streaming',
        'Core gameplay & UI',
        'TypeScript Dragon battles',
      ],
    },
    {
      title: 'Enhancement',
      duration: '6 Weeks',
      status: 'upcoming',
      features: [
        'Agent coordination visuals',
        'Advanced UI panels',
        'Performance optimization',
        'Tutorial system',
      ],
    },
    {
      title: 'Advanced Features',
      duration: '8 Weeks',
      status: 'upcoming',
      features: [
        'Agent leveling & mastery',
        'Quest chains',
        'Save/load functionality',
        'Replay system',
      ],
    },
    {
      title: 'Multiplayer',
      duration: '12 Weeks',
      status: 'future',
      features: [
        'Shared world state',
        'Voice chat integration',
        'Collaborative debugging',
        'Persistence backend',
      ],
    },
  ];

  const features = [
    {
      icon: '🎯',
      title: 'RTS-Style Controls',
      description: 'Drag-select agents like in Starcraft. Command your digital workforce with intuitive point-and-click.',
    },
    {
      icon: '👁️',
      title: 'Agent Visualization',
      description: 'See every agent as a character on the battlefield. Watch them think, move, and collaborate in real-time.',
    },
    {
      icon: '🐉',
      title: 'Battle Dragons',
      description: 'Errors spawn as fearsome dragons. Watch your agents fight TypeScript dragons with their tools.',
    },
    {
      icon: '⚔️',
      title: 'Equip Tools',
      description: 'Tools are equipment. Equip your agents with search spyglasses, code hammers, and data keys.',
    },
    {
      icon: '🗺️',
      title: 'Strategic Map',
      description: 'Goals are castles to capture. See the entire battlefield at once or zoom in on individual agents.',
    },
    {
      icon: '⚡',
      title: 'Real-Time Coordination',
      description: 'Watch agents collaborate. See connection lines, shared resources, and formation movements.',
    },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white overflow-hidden relative">
      {/* Animated background grid */}
      <div className="fixed inset-0 z-0">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0a0f] via-[#12121a] to-[#0a0a0f]" />
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255, 107, 53, 0.1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255, 107, 53, 0.1) 1px, transparent 1px)
            `,
            backgroundSize: '50px 50px',
            transform: `perspective(500px) rotateX(60deg) translateY(-50px) translateZ(-200px)`,
            animation: 'gridMove 20s linear infinite',
          }}
        />
      </div>

      <motion.div
        className="relative z-10"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Hero Section */}
        <section className="min-h-screen flex items-center justify-center relative px-6">
          {/* Floating orbs */}
          <motion.div
            className="absolute top-20 left-20 w-64 h-64 bg-[#ff6b35] rounded-full blur-[120px] opacity-20"
            animate={{
              x: mousePosition.x * 0.02,
              y: mousePosition.y * 0.02,
            }}
          />
          <motion.div
            className="absolute bottom-20 right-20 w-96 h-96 bg-[#00d4ff] rounded-full blur-[150px] opacity-10"
            animate={{
              x: mousePosition.x * -0.02,
              y: mousePosition.y * -0.02,
            }}
          />

          <div className="max-w-6xl mx-auto text-center">
            <motion.div variants={itemVariants} className="mb-6">
              <div className="inline-block px-6 py-2 bg-[#ff6b35]/10 border border-[#ff6b35]/30 rounded-full">
                <span className="text-[#ff6b35] font-mono text-sm uppercase tracking-widest">
                  🎮 Starcraft for AI Agents
                </span>
              </div>
            </motion.div>

            <motion.h1
              variants={itemVariants}
              className="text-7xl md:text-9xl font-black mb-8 leading-none"
              style={{
                fontFamily: 'impact, sans-serif',
                textShadow: '0 0 80px rgba(255, 107, 53, 0.5)',
              }}
            >
              <span className="bg-gradient-to-r from-[#ff6b35] via-[#ff8c61] to-[#00d4ff] bg-clip-text text-transparent">
                AGENTS
              </span>
              <br />
              <span className="text-white">OF EMPIRE</span>
            </motion.h1>

            <motion.p
              variants={itemVariants}
              className="text-xl md:text-2xl text-gray-400 mb-12 max-w-3xl mx-auto leading-relaxed"
            >
              Command your AI agents like game units. Watch them battle dragons on a 3D
              battlefield. No more terminals. No more node editors. Just pure strategy.
            </motion.p>

            <motion.div
              variants={itemVariants}
              className="flex flex-col sm:flex-row gap-4 justify-center items-center"
            >
              <button
                onClick={() => {
                  // TODO: Implement waitlist signup
                  console.log("Waitlist signup clicked");
                }}
                className="group relative px-8 py-4 bg-[#ff6b35] hover:bg-[#ff8c61] text-white font-bold text-lg rounded-lg transition-all duration-300 transform hover:scale-105 hover:shadow-[0_0_40px_rgba(255,107,53,0.6)]"
              >
                <span className="relative z-10 flex items-center gap-2">
                  ⚔️ Join the Waitlist
                  <motion.span
                    className="inline-block"
                    animate={{ x: [0, 5, 0] }}
                    transition={{ duration: 1, repeat: Infinity }}
                  >
                    →
                  </motion.span>
                </span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  console.log("Enter Game button clicked");
                  if (onEnterGame) {
                    onEnterGame();
                  } else {
                    console.error("onEnterGame is not defined");
                  }
                }}
                className="px-8 py-4 bg-transparent border-2 border-white/20 hover:border-[#00d4ff] text-white font-bold text-lg rounded-lg transition-all duration-300 hover:shadow-[0_0_30px_rgba(0,212,255,0.3)]"
              >
                🎮 Enter the Game
              </button>
            </motion.div>

            <motion.div
              variants={itemVariants}
              className="mt-16 flex justify-center gap-8 text-gray-500 font-mono text-sm"
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-[#ff6b35] rounded-full animate-pulse" />
                React Three Fiber
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-[#00d4ff] rounded-full animate-pulse" />
                LangGraph Deep Agents
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-[#ff6b35] rounded-full animate-pulse" />
                Zustand State
              </div>
            </motion.div>
          </div>
        </section>

        {/* Features Section */}
        <section className="py-32 px-6 relative">
          <div className="max-w-7xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 50 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
              className="text-center mb-20"
            >
              <h2 className="text-5xl md:text-7xl font-black mb-6">
                <span className="bg-gradient-to-r from-white to-gray-500 bg-clip-text text-transparent">
                  GAME CHANGING
                </span>
              </h2>
              <p className="text-xl text-gray-400 max-w-2xl mx-auto">
                Finally, an interface that treats AI agents like what they are: your digital army
              </p>
            </motion.div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {features.map((feature, index) => (
                <motion.div
                  key={feature.title}
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.1, duration: 0.6 }}
                  whileHover={{ scale: 1.02, y: -5 }}
                  className="group relative p-8 bg-gradient-to-br from-white/5 to-white/0 border border-white/10 rounded-2xl hover:border-[#ff6b35]/50 transition-all duration-300"
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-[#ff6b35]/0 to-[#ff6b35]/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-2xl" />
                  <div className="relative z-10">
                    <div className="text-5xl mb-4">{feature.icon}</div>
                    <h3 className="text-2xl font-bold mb-3 text-white group-hover:text-[#ff6b35] transition-colors">
                      {feature.title}
                    </h3>
                    <p className="text-gray-400 leading-relaxed">{feature.description}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Launch Plan Section */}
        <section className="py-32 px-6 relative">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#ff6b35]/5 to-transparent" />
          <div className="max-w-6xl mx-auto relative z-10">
            <motion.div
              initial={{ opacity: 0, y: 50 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
              className="text-center mb-20"
            >
              <h2 className="text-5xl md:text-7xl font-black mb-6">
                <span className="bg-gradient-to-r from-[#ff6b35] to-[#ff8c61] bg-clip-text text-transparent">
                  LAUNCH ROADMAP
                </span>
              </h2>
              <p className="text-xl text-gray-400 max-w-2xl mx-auto">
                From MVP to multiplayer: The journey to revolutionizing agent orchestration
              </p>
            </motion.div>

            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-1/2 transform -translate-x-1/2 h-full w-1 bg-gradient-to-b from-[#ff6b35] via-[#00d4ff] to-gray-700 hidden md:block" />

              <div className="space-y-16">
                {phases.map((phase, index) => (
                  <motion.div
                    key={phase.title}
                    initial={{ opacity: 0, x: index % 2 === 0 ? -50 : 50 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: index * 0.2, duration: 0.6 }}
                    className={`relative flex items-center ${
                      index % 2 === 0 ? 'md:flex-row' : 'md:flex-row-reverse'
                    }`}
                  >
                    {/* Timeline dot */}
                    <div className="hidden md:flex absolute left-1/2 transform -translate-x-1/2 w-6 h-6 rounded-full border-4 border-[#0a0a0f] bg-[#ff6b35] z-10 items-center justify-center">
                      {phase.status === 'active' && (
                        <div className="w-2 h-2 bg-[#ff6b35] rounded-full animate-ping" />
                      )}
                    </div>

                    <div
                      className={`w-full md:w-5/12 ml-auto md:ml-0 ${
                        index % 2 === 0 ? 'md:pr-16' : 'md:pl-16'
                      }`}
                    >
                      <div
                        className={`p-8 rounded-2xl border-2 transition-all duration-300 ${
                          phase.status === 'active'
                            ? 'bg-[#ff6b35]/10 border-[#ff6b35] shadow-[0_0_40px_rgba(255,107,53,0.3)]'
                            : phase.status === 'upcoming'
                            ? 'bg-white/5 border-white/10 hover:border-[#00d4ff]/50'
                            : 'bg-white/5 border-white/10 hover:border-white/20'
                        }`}
                      >
                        <div className="flex items-center gap-3 mb-4">
                          <div
                            className={`px-3 py-1 rounded-full text-sm font-bold uppercase tracking-wider ${
                              phase.status === 'active'
                                ? 'bg-[#ff6b35] text-white'
                                : 'bg-white/10 text-gray-400'
                            }`}
                          >
                            {phase.status}
                          </div>
                          <div className="text-gray-500 font-mono text-sm">
                            {phase.duration}
                          </div>
                        </div>

                        <h3 className="text-3xl font-black mb-4 text-white">
                          {phase.title}
                        </h3>

                        <ul className="space-y-2">
                          {phase.features.map((feature) => (
                            <li key={feature} className="flex items-start gap-2 text-gray-400">
                              <span className="text-[#ff6b35] mt-1">▹</span>
                              <span>{feature}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="py-32 px-6 relative">
          <div className="max-w-4xl mx-auto text-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
              className="relative"
            >
              {/* Glow effect */}
              <div className="absolute inset-0 bg-gradient-to-r from-[#ff6b35] via-[#00d4ff] to-[#ff6b35] rounded-3xl blur-[100px] opacity-20" />

              <div className="relative bg-gradient-to-br from-white/10 to-white/5 border border-white/10 rounded-3xl p-12 md:p-16">
                <h2 className="text-4xl md:text-6xl font-black mb-6">
                  Ready to
                  <span className="bg-gradient-to-r from-[#ff6b35] to-[#00d4ff] bg-clip-text text-transparent">
                    {' '}
                    Command?
                  </span>
                </h2>
                <p className="text-xl text-gray-400 mb-10 max-w-2xl mx-auto">
                  Join the waitlist and be among the first to experience the future of AI agent
                  orchestration. No more terminals. Just pure strategy.
                </p>

                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                  <button
                    onClick={() => {
                      console.log("Waitlist signup clicked");
                    }}
                    className="group relative px-10 py-5 bg-[#ff6b35] hover:bg-[#ff8c61] text-white font-bold text-xl rounded-xl transition-all duration-300 transform hover:scale-105 hover:shadow-[0_0_50px_rgba(255,107,53,0.6)]"
                  >
                    <span className="relative z-10">⚔️ Join Waitlist</span>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      console.log("Launch Demo button clicked");
                      if (onEnterGame) {
                        onEnterGame();
                      } else {
                        console.error("onEnterGame is not defined");
                      }
                    }}
                    className="px-10 py-5 bg-white/5 hover:bg-white/10 border-2 border-white/20 hover:border-[#00d4ff] text-white font-bold text-xl rounded-xl transition-all duration-300"
                  >
                    🎮 Launch Demo
                  </button>
                </div>

                <div className="mt-10 flex justify-center gap-6 text-sm text-gray-500">
                  <a
                    href="https://github.com"
                    className="hover:text-[#ff6b35] transition-colors flex items-center gap-2"
                  >
                    <span>⭐</span> Star on GitHub
                  </a>
                  <a
                    href="https://discord.com"
                    className="hover:text-[#00d4ff] transition-colors flex items-center gap-2"
                  >
                    <span>💬</span> Join Discord
                  </a>
                  <a
                    href="https://twitter.com"
                    className="hover:text-[#ff6b35] transition-colors flex items-center gap-2"
                  >
                    <span>🐦</span> Follow Updates
                  </a>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-12 px-6 border-t border-white/10">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎮</span>
              <span className="font-bold text-xl">Agents of Empire</span>
            </div>
            <div className="text-gray-500 text-sm">
              Built with{' '}
              <span className="text-[#ff6b35]">♥</span> for the AI agent revolution
            </div>
            <div className="flex gap-6 text-sm text-gray-400">
              <a href="#" className="hover:text-white transition-colors">
                GitHub
              </a>
              <a href="#" className="hover:text-white transition-colors">
                Discord
              </a>
              <a href="#" className="hover:text-white transition-colors">
                Docs
              </a>
            </div>
          </div>
        </footer>
      </motion.div>

      <style>{`
        @keyframes gridMove {
          0% {
            transform: perspective(500px) rotateX(60deg) translateY(0) translateZ(-200px);
          }
          100% {
            transform: perspective(500px) rotateX(60deg) translateY(50px)
              translateZ(-200px);
          }
        }
      `}</style>
    </div>
  );
};

export default Landing;
