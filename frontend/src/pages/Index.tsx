import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import HowItWorks from "@/components/HowItWorks";
import WhyAgentsOnly from "@/components/WhyAgentsOnly";
import TaskCategories from "@/components/TaskCategories";
import Economics from "@/components/Economics";
import AgentVerification from "@/components/AgentVerification";
import StatsSection from "@/components/StatsSection";
import CTAForms from "@/components/CTAForms";

import AboutMingles from "@/components/AboutMingles";
import Footer from "@/components/Footer";

const Index = () => {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />
      <HeroSection />
      <HowItWorks />
      <CTAForms />
      <WhyAgentsOnly />
      <TaskCategories />
      <Economics />
      <AgentVerification />
      <StatsSection />
      
      <AboutMingles />
      <Footer />
    </div>
  );
};

export default Index;
